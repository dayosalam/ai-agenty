import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { User } from '../models/index.js'
import { groupRepository, userRepository } from '../repositories/index.js'
import { courseDisplay, parseCourseList } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'
import { describeResume, parsePause } from '../utils/duration.js'
import { conversationService } from './conversation.service.js'
import { DeliveryService } from './delivery.service.js'
import { onboardingService } from './onboarding.service.js'

/** "abeg send", "pls help" — politeness, not part of the instruction. */
const FILLER = /^(abeg|pls|plz|please|oga|bros|guy|hey|hi|yo|una)\s+/i

const HELP = /^(help|menu|commands?|what can you do|wetin you (fit )?do|how you dey work)\??$/i
const LIST =
  /^(my courses?|courses?|what courses?.*|which courses?.*|wetin i dey (follow|do)|list)$/i
const ADD = /^(add|join|include|i'?m (also )?(taking|doing)|i am (also )?(taking|doing))\b/i
const REMOVE = /^(remove|drop|delete|leave|unsubscribe|comot|take off|stop watching)\b/i
const SETTINGS = /^settings?\b/i

const PAUSE =
  /^(pause|snooze|mute|hold|stop|quiet|shut ?up|go quiet|no dey send|stop sending|don'?t send|dont send|stop messaging|leave me)\b/i
const RESUME =
  /^(resume|unpause|unmute|continue|start (again|sending)|carry on|go on|back on|wake up|you can (start|continue))\b/i

/** "digest on" reads as a resume, but only RESUME's course-and-digest branch knows it. */
const DIGEST_ON = /^digest\s+(on|back|resume)\b/i

const URGENT_ONLY =
  /^(only|just)\s+(the\s+)?(urgent|important|serious)|^urgent (only|stuff|things)/i
const EVERYTHING = /^(everything|all alerts|send everything|tell me everything|all of it)$/i

const QUIET = /^quiet\b/i

const NAME = /^(call me|change my name|my name is|i'?m called|rename me|change name)\b/i

/** Checked before REMOVE, which would otherwise read "remove everything" as a course. */
const WIPE =
  /^(remove|delete|clear|forget|wipe)\s+(everything|all|me|my (data|account|details|courses))\b|^(unregister|forget me|remove me|delete my account|stop completely)$/i

const REPEAT = /^(repeat( that| it)?|say (that|it) again|come again|what did you (just )?say)\??$/i

const CONFIRM = /^(yes|yeah|yep|confirm|do it|go ahead|proceed|sure|delete|na so)$/i
const DECLINE = /^(no|nope|cancel|forget it|leave it|never ?mind|nah|abort|stop)$/i

/** Single words worth correcting. Anything shorter is too easy to mistake for a word. */
const VOCAB = [
  'help',
  'menu',
  'settings',
  'courses',
  'resume',
  'pause',
  'digest',
  'mute',
  'unmute',
  'confirm',
  'cancel',
]

const HELP_TEXT = `Here's what I can do 👇

*Ask me anything about your courses*
_"when is the CSC 301 test?"_
_"where is it holding?"_
_"what's due this week?"_

*Get the files*
_"CSC 301 resources"_ — sends the actual documents

*Catch up*
_"what did I miss this week?"_

*Manage your courses*
*my courses* · *add MTH 101* · *remove STA 202*

*Quiet me down*
*pause until Monday* · *pause for 2 days* · *resume*
*mute STA 202* — stop the pings for one course
*only urgent* — tests, deadlines and venue changes only
*stop the morning digest* — keep the instant alerts
*quiet off* — stop holding alerts overnight

*Your digest*
*settings* — see it · *settings 6am voice* — change it

I only know what was said in a group after I joined it.`

/**
 * Commands a registered student can send.
 *
 * Matched literally, before the model sees anything. Two reasons: an instruction
 * routed as a question gets answered by searching the group archive for it, which
 * looks broken to someone who was not asking anything — and a student who wants to
 * be left alone should not need a working OpenAI key to be left alone.
 *
 * Written for how people actually type: Pidgin forms, one-word typos, politeness
 * prefixes, and two instructions in one message.
 */
export class StudentCommandsService {
  /** Returns a reply, or null when the text is an ordinary question. */
  async handle(user: User, text: string): Promise<string | null> {
    // Answered against the raw text: somebody called Muse is one edit from "mute",
    // and correcting a typo in a name is how you end up calling them Mute.
    const answered = await this.resolvePending(user, text.trim())
    if (answered !== null) return answered

    const cleaned = this.clean(text)

    if (HELP.test(cleaned)) return HELP_TEXT
    // Literal, before the router: re-running retrieval for "say that again" can
    // return a different answer, which is the one thing repeating must not do.
    if (REPEAT.test(cleaned)) {
      return (
        (await conversationService.lastAnswer(user.phone)) ??
        "I haven't told you anything yet — ask me something first."
      )
    }
    if (WIPE.test(cleaned)) return this.askToWipe(user)
    if (NAME.test(cleaned)) return this.rename(user, cleaned)
    if (SETTINGS.test(cleaned)) return this.settings(user, cleaned)
    if (QUIET.test(cleaned)) return this.quietHours(user, cleaned)
    if (URGENT_ONLY.test(cleaned)) return this.setLevel(user, 'urgent')
    if (EVERYTHING.test(cleaned)) return this.setLevel(user, 'all')
    if (PAUSE.test(cleaned)) return this.pause(user, cleaned)
    if (RESUME.test(cleaned) || DIGEST_ON.test(cleaned)) return this.resume(user, cleaned)
    if (LIST.test(cleaned)) return this.list(user)

    // "add CSC 301 and remove STA 202" is two instructions; running only the first
    // silently ignores half of what they asked for.
    const compound = this.splitCompound(cleaned)
    if (compound) {
      // Sequential, not concurrent: both halves write the same document, and run
      // together the second overwrites the first with a courseKeys list that never
      // saw the addition.
      const added = await this.add(user, compound.add)
      const removed = await this.remove(await this.reload(user), compound.remove)
      return `${added}\n\n${removed}`
    }

    if (ADD.test(cleaned)) return this.add(user, cleaned)
    if (REMOVE.test(cleaned)) return this.remove(user, cleaned)

    return null
  }

  /**
   * Strips what does not carry meaning, and repairs a one-word typo.
   *
   * Correction is limited to a message that is a single word. "helpp" is obviously
   * help; a "help" buried in a sentence is usually a plea, not a command, and
   * rewriting words inside a real question would change what was asked.
   */
  private clean(text: string): string {
    const trimmed = text
      .trim()
      .replace(FILLER, '')
      .replace(/[?!.,]+$/, '')
      .trim()
    if (/\s/.test(trimmed)) return trimmed

    const lower = trimmed.toLowerCase()
    if (lower.length < 4 || VOCAB.includes(lower)) return trimmed
    return VOCAB.find((word) => distance(lower, word) <= 1) ?? trimmed
  }

  /**
   * The answer to something Peermate asked, before anything else is considered.
   *
   * A message that is not an answer drops the question rather than repeating it.
   * People change their mind mid-thought and ask something else entirely, and a bot
   * that keeps demanding an answer to a question nobody wants any more is a bot you
   * cannot get out of. Nothing is destroyed without an explicit yes either way.
   */
  private async resolvePending(user: User, text: string): Promise<string | null> {
    const pending = (await conversationService.get(user.phone))?.pendingAction
    // awaiting_resource_course is DmService's to answer — it ends in files being
    // sent, which commands cannot do. Clearing it here would strand the student.
    if (pending !== 'confirm_wipe' && pending !== 'awaiting_name') return null

    await conversationService.expect(user.phone, null)

    if (DECLINE.test(text)) {
      return pending === 'confirm_wipe'
        ? "Left everything as it is — you'll keep hearing from me."
        : "No problem, I'll keep calling you what I already do."
    }

    if (pending === 'awaiting_name') {
      const name = onboardingService.readName(text)
      if (!name) return null
      await userRepository.upsert({ ...user, displayName: name })
      return `Done — I'll call you *${name}* from now on.`
    }

    return CONFIRM.test(text) ? this.wipe(user) : null
  }

  /**
   * Two steps, always.
   *
   * This is the only irreversible thing a student can ask for, and "remove
   * everything" is close enough to "remove CVE 575" that a misread would cost them
   * the semester's alerts with no way to get them back.
   */
  private async askToWipe(user: User): Promise<string> {
    await conversationService.expect(user.phone, 'confirm_wipe')
    const courses = user.courseKeys.map(courseDisplay).join(', ')
    return `Just to be sure — this removes ${user.courseKeys.length ? `*${courses}*` : 'your registration'} and everything I have for you, and I'll stop messaging you entirely.

Send *yes* to go ahead, or anything else to leave it.

If you only want me to be quiet for a while, send *pause* instead.`
  }

  private async wipe(user: User): Promise<string> {
    await userRepository.upsert({
      ...user,
      displayName: null,
      courseKeys: [],
      mutedCourseKeys: [],
      paused: false,
      pausedUntil: null,
      onboardingState: 'awaiting_name',
      registeredAt: null,
    })
    await conversationService.forget(user.phone)
    logger.info({ phone: user.phone }, 'student removed themselves')
    return `Done. I've cleared your courses and I won't message you again.

Message me any time and we can start over.`
  }

  private async rename(user: User, text: string): Promise<string> {
    const said = text
      .replace(NAME, '')
      .replace(/^\s*to\s+/i, '')
      .trim()
    const name = said ? onboardingService.readName(said) : null

    if (!name) {
      await conversationService.expect(user.phone, 'awaiting_name')
      return 'What should I call you?'
    }

    await userRepository.upsert({ ...user, displayName: name })
    logger.info({ phone: user.phone }, 'display name changed')
    return `Done — I'll call you *${name}* from now on.`
  }

  /**
   * The overnight window, which is the one setting people discover by accident.
   *
   * Alerts held between 10pm and 6am look identical to alerts that never arrived —
   * the student assumes Peermate is broken. It needs to be switchable in one word.
   */
  private async quietHours(user: User, text: string): Promise<string> {
    const rest = text.replace(QUIET, '').trim()

    if (/^(off|no|none|never|0)$/i.test(rest)) {
      await userRepository.upsert({ ...user, quietFrom: null, quietTo: null })
      return `Quiet hours off — I'll message you the moment anything lands, whatever the time.`
    }

    const hours = [...rest.matchAll(/\b(\d{1,2})\s*(am|pm)?\b/gi)].map((match) => {
      const value = Number(match[1])
      if (match[2]?.toLowerCase() === 'pm' && value < 12) return value + 12
      if (match[2]?.toLowerCase() === 'am' && value === 12) return 0
      return value
    })

    if (hours.length < 2 || hours.some((hour) => hour > 23)) {
      const current =
        user.quietFrom !== null && user.quietTo !== null
          ? `Right now I hold them between ${formatTime12(`${String(user.quietFrom).padStart(2, '0')}:00`)} and ${formatTime12(`${String(user.quietTo).padStart(2, '0')}:00`)}.`
          : `Right now I never hold them.`
      return `${current}\n\nChange it like *quiet 11pm to 7am*, or send *quiet off*.`
    }

    await userRepository.upsert({ ...user, quietFrom: hours[0]!, quietTo: hours[1]! })
    logger.info({ phone: user.phone, from: hours[0], to: hours[1] }, 'quiet hours changed')
    return `Done — I'll hold instant alerts between ${formatTime12(`${String(hours[0]).padStart(2, '0')}:00`)} and ${formatTime12(`${String(hours[1]).padStart(2, '0')}:00`)}, and put them in your digest instead.`
  }

  private async setLevel(user: User, alertLevel: 'all' | 'urgent'): Promise<string> {
    await userRepository.upsert({ ...user, alertLevel })
    logger.info({ phone: user.phone, alertLevel }, 'alert level changed')
    return alertLevel === 'urgent'
      ? `Done. I'll only ping you about tests, deadlines and venue changes from now on.\n\nEverything else still turns up in your morning digest, so nothing is lost. Send *everything* to go back.`
      : `Done — you'll hear about everything again.`
  }

  /**
   * "pause", "stop the morning messages", "mute STA 202", "pause until Monday".
   *
   * One verb, three scopes. Which one they meant is in the rest of the sentence, and
   * getting it wrong in the silencing direction is the safer error — a student who
   * asked for quiet and got too much quiet can say *resume*.
   */
  private async pause(user: User, text: string): Promise<string> {
    if (/\b(digest|morning|daily|summary|rundown)\b/i.test(text)) {
      await userRepository.upsert({ ...user, digestPaused: true })
      logger.info({ phone: user.phone }, 'digest paused')
      return `No more morning messages. I'll still ping you when something lands in your groups.\n\nSend *digest on* to bring it back.`
    }

    const named = parseCourseList(text).filter((key) => user.courseKeys.includes(key))
    if (named.length > 0) {
      const muted = [...new Set([...user.mutedCourseKeys, ...named])]
      await userRepository.upsert({ ...user, mutedCourseKeys: muted })
      logger.info({ phone: user.phone, named }, 'courses muted')
      return `Muted *${named.map(courseDisplay).join(', ')}* — no more pings.\n\nIt still shows up in your morning digest. Send *unmute ${courseDisplay(named[0]!)}* to undo.`
    }

    const { until } = parsePause(text, config.digest.timezone)
    await userRepository.upsert({
      ...user,
      paused: until === null,
      pausedUntil: until,
    })
    logger.info({ phone: user.phone, until }, 'alerts paused')

    // Said plainly, because "paused" sounds like "deleted" to someone worried about
    // missing a test.
    const tail = `\n\nNothing gets lost — whatever comes up will be in your first digest after that.`
    return until
      ? `Alright, I'll go quiet until *${describeResume(until, config.digest.timezone)}*.${tail}`
      : `Alright, I'll go quiet. Send *resume* whenever you want me back.${tail}`
  }

  private async resume(user: User, text: string): Promise<string> {
    if (/\b(digest|morning|daily|summary)\b/i.test(text)) {
      await userRepository.upsert({ ...user, digestPaused: false })
      return `Morning digest is back on — next one arrives at *${this.digestTime(user)}*.`
    }

    const named = parseCourseList(text)
    if (named.length > 0) {
      const muted = user.mutedCourseKeys.filter((key) => !named.includes(key))
      await userRepository.upsert({ ...user, mutedCourseKeys: muted })
      return `Unmuted *${named.map(courseDisplay).join(', ')}*.`
    }

    const wasQuiet = user.paused || user.pausedUntil !== null || user.digestPaused
    await userRepository.upsert({
      ...user,
      paused: false,
      pausedUntil: null,
      digestPaused: false,
    })
    logger.info({ phone: user.phone }, 'alerts resumed')

    return wasQuiet
      ? `I'm back on 👍 You'll hear from me as soon as something comes up.`
      : `I wasn't holding anything back — you'll hear from me as soon as something comes up.`
  }

  /**
   * The digest is the only thing a student can tune.
   *
   * PRD §8 ruled out per-user toggles in the prototype; this reverses that for the
   * digest alone, because a 7am message is useless to someone whose day starts at 6
   * and a voice note is useless to someone on metered data.
   */
  private async settings(user: User, text: string): Promise<string> {
    const rest = text.replace(SETTINGS, '').trim()

    if (!rest) {
      const how = user.digestFormat === 'voice' ? 'voice note and text' : 'text'
      const quiet =
        user.quietFrom !== null && user.quietTo !== null
          ? `\nInstant alerts are held between ${formatTime12(`${String(user.quietFrom).padStart(2, '0')}:00`)} and ${formatTime12(`${String(user.quietTo).padStart(2, '0')}:00`)} — they arrive in the digest instead.`
          : ''

      const holds = DeliveryService.describeHolds(user)
      const muted = user.mutedCourseKeys.length
        ? `\nMuted: ${user.mutedCourseKeys.map(courseDisplay).join(', ')}.`
        : ''
      const status = holds.length ? `\n\n${holds.join('\n')}` : ''

      return `*Your digest*\n\nArrives at *${this.digestTime(user)}*, as *${how}*.${quiet}${muted}${status}\n\nChange it like *settings 6am voice* or *settings 8am text*.`
    }

    const { hour, format } = onboardingService.parseDigestPreference(rest)
    await userRepository.upsert({ ...user, digestHour: hour, digestFormat: format })
    logger.info({ phone: user.phone, hour, format }, 'digest settings changed')

    const when = formatTime12(`${String(hour).padStart(2, '0')}:00`)
    const how = format === 'voice' ? 'a voice note and text' : 'text'
    return `Done — your digest now arrives at *${when}* as ${how}.`
  }

  private digestTime(user: User): string {
    return formatTime12(`${String(user.digestHour).padStart(2, '0')}:00`) ?? '7am'
  }

  private async list(user: User): Promise<string> {
    if (user.courseKeys.length === 0) {
      return "You're not watching any courses yet. Send me the codes, like *CSC 301, STA 202*."
    }

    const groups = await groupRepository.approved()
    const covered = new Set(groups.map((group) => group.defaultCourseKey).filter(Boolean))
    const lines = user.courseKeys.map((key) => {
      const muted = user.mutedCourseKeys.includes(key) ? ' _(muted)_' : ''
      return covered.has(key)
        ? `✅ *${courseDisplay(key)}* — connected${muted}`
        : `⚠️ *${courseDisplay(key)}* — I'm not in a group for this yet`
    })

    return `You're watching:\n\n${lines.join('\n')}\n\n*add <code>* or *remove <code>* to change this.`
  }

  private async add(user: User, text: string): Promise<string> {
    const keys = parseCourseList(text)
    if (keys.length === 0) return 'Which course? Send it like *add MTH 101*.'

    const added = keys.filter((key) => !user.courseKeys.includes(key))
    if (added.length === 0) {
      return `You're already watching ${keys.map(courseDisplay).join(', ')}.`
    }

    await userRepository.upsert({ ...user, courseKeys: [...user.courseKeys, ...added] })
    logger.info({ phone: user.phone, added }, 'courses added')

    const groups = await groupRepository.approved()
    const covered = new Set(groups.map((group) => group.defaultCourseKey).filter(Boolean))
    const lines = added.map((key) =>
      covered.has(key)
        ? `✅ *${courseDisplay(key)}* — connected`
        : `⚠️ *${courseDisplay(key)}* — I'm not in a group for this yet`,
    )
    return `Added:\n\n${lines.join('\n')}`
  }

  private async remove(user: User, text: string): Promise<string> {
    const keys = parseCourseList(text)
    if (keys.length === 0) return 'Which course? Send it like *remove STA 202*.'

    const removed = keys.filter((key) => user.courseKeys.includes(key))
    if (removed.length === 0) {
      return `You weren't watching ${keys.map(courseDisplay).join(', ')} anyway.`
    }

    const remaining = user.courseKeys.filter((key) => !removed.includes(key))
    await userRepository.upsert({ ...user, courseKeys: remaining })
    logger.info({ phone: user.phone, removed }, 'courses removed')

    const tail = remaining.length
      ? `\n\nStill watching: ${remaining.map(courseDisplay).join(', ')}`
      : "\n\nYou're not watching anything now, so I won't message you until you add a course."
    return `Stopped watching ${removed.map(courseDisplay).join(', ')}.${tail}`
  }

  /** "add CSC 301 and remove STA 202", in either order. */
  private splitCompound(text: string): { add: string; remove: string } | null {
    const addAt = text.search(/\b(add|join|include)\b/i)
    const removeAt = text.search(/\b(remove|drop|comot|unsubscribe)\b/i)
    if (addAt < 0 || removeAt < 0) return null

    return addAt < removeAt
      ? { add: text.slice(addAt, removeAt), remove: text.slice(removeAt) }
      : { add: text.slice(addAt), remove: text.slice(removeAt, addAt) }
  }

  /** The second half of a compound command must see what the first half wrote. */
  private async reload(user: User): Promise<User> {
    return (await userRepository.findByPhone(user.phone)) ?? user
  }
}

/** Levenshtein, capped at the two rows it needs. */
function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost)
    }
    previous = current
  }
  return previous[b.length]!
}

export const studentCommandsService = new StudentCommandsService()
