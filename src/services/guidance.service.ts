import type { User } from '../models/index.js'
import { groupRepository } from '../repositories/index.js'
import { courseDisplay } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'

/** "how do I", "how can I", "how i go" — asking the way, not asking the answer. */
const HOW =
  /\b(how (do|can|would|should) (i|you|we)|how to|how i go|how does (this|it|you)|what does .+ (do|mean)|where do i)\b/i

/**
 * Words that make a "how do I…" about Peermate rather than about the world.
 *
 * Without this gate "how do I know if the test moved?" is a question about a course,
 * and answering it with instructions would be worse than searching for it.
 */
const ABOUT_PEERMATE =
  /\b(approve|approval|group|course|register|sign ?up|add|remove|drop|digest|summary|resource|file|slide|document|pause|mute|quiet|stop|snooze|settings?|name|use you|work|command|notification|alert)\b/i

/**
 * Asking what Peermate is set up to do, rather than how to set it up.
 *
 * "What group have you been approved for?" was being routed as unsupported — told it
 * was outside what Peermate does, when Peermate is the only thing that knows the
 * answer. The lookahead keeps it off content questions: "what group did he post that
 * in?" is about a classmate, not about Peermate, and belongs to retrieval.
 */
const SELF_STATE =
  /\b(?:what|which|how many)\s+groups?\b(?=.*\b(?:you|your|approved|reading|listening|connected|set ?up)\b)|\b(?:have|has)\s+you\s+been\s+(?:approved|added)\b|\bare\s+you\s+(?:reading|listening|in|connected|approved)\b|\bwhat\s+(?:are|do)\s+you\s+(?:reading|watching|connected)\b/i

interface Topic {
  match: RegExp
  answer: (context: Context) => Promise<string> | string
}

interface Context {
  user: User
  isOperator: boolean
}

/**
 * Answers questions about Peermate itself.
 *
 * "How do I approve it?" was going to the question router, which searched the group
 * archive for an announcement about approving things, found none, and replied that it
 * had not heard anything — which reads as broken to somebody who was asking for
 * instructions. Peermate knows its own commands; that should never need retrieval,
 * and it should never cost a model call.
 *
 * Answers are written against live state where there is any: naming the group that is
 * actually waiting, and the course somebody actually proposed for it, beats a generic
 * example the reader then has to translate.
 */
export class GuidanceService {
  /** Whether this is a question about Peermate rather than about a course. */
  looksLikeAboutPeermate(text: string): boolean {
    return SELF_STATE.test(text) || (HOW.test(text) && ABOUT_PEERMATE.test(text))
  }

  async answer(user: User, text: string, isOperator: boolean): Promise<string> {
    const topic = TOPICS.find((candidate) => candidate.match.test(text))
    return topic ? topic.answer({ user, isOperator }) : general({ user, isOperator })
  }
}

const TOPICS: Topic[] = [
  // Before the how-to topics: "which groups are you reading?" is asking what is set
  // up, not how to set it up, and the two want opposite answers.
  { match: SELF_STATE, answer: listening },
  {
    match: /\b(approve|approval|listen|read (the |a )?group|set ?up (the |a )?group)\b/i,
    answer: approving,
  },
  { match: /\b(group)\b/i, answer: approving },
  {
    match: /\b(add|remove|drop|change|another)\b.*\bcourse|course.*\b(add|remove|drop)\b/i,
    answer: courses,
  },
  // Before the resources topic, which shares most of its words: "send me the past
  // questions" and "quiz me on the past questions" want different things.
  { match: /\b(prep|revis\w*|study|quiz|practice|exam prep|read for)\b/i, answer: prep },
  { match: /\b(resource|file|slide|document|pdf|past ?question|note)s?\b/i, answer: resources },
  { match: /\b(digest|summary|rundown|morning|voice ?note|settings?)\b/i, answer: digest },
  { match: /\b(pause|mute|quiet|stop|snooze|silence|notification|alert)s?\b/i, answer: quiet },
  {
    match: /\b(name|call me)\b/i,
    answer: () => "Send *call me Ada* — or just *change my name* and I'll ask.",
  },
  { match: /\bcourse/i, answer: courses },
]

/** Revision, and the one thing it depends on. */
function prep(): string {
  return `Send *prep me for CSC 301* and I'll build a practice set out of the slides, notes and past questions people shared in that group — what the material covers, then questions in the style your lecturer sets.

Then *quiz me* and I'll ask them one at a time and mark your answers.

I can only do this for a course whose files I actually have. If nobody has posted any, send them to me yourself.`
}

/**
 * What is actually connected right now.
 *
 * The only source for this is Peermate itself, so answering it with "that's outside
 * what I do" is the least useful thing it could say. Pending groups are named too: a
 * student wondering why they hear nothing from a group usually has one sitting
 * unapproved, and that is the answer.
 */
async function listening({ isOperator, user }: Context): Promise<string> {
  const [live, waiting] = await Promise.all([groupRepository.approved(), groupRepository.pending()])

  if (live.length === 0 && waiting.length === 0) {
    return `I'm not reading any group yet. Add me to a course group and I'll ask about it — I read nothing until it's approved.`
  }

  const reading = live.length
    ? `*Reading ${live.length} group${live.length === 1 ? '' : 's'}:*\n${live
        .map(
          (group) => `• ${group.name ?? group.chatJid} → ${group.defaultCourse ?? 'no course set'}`,
        )
        .join('\n')}`
    : `I'm not reading any group yet.`

  if (waiting.length === 0) {
    // Their own coverage is the part they actually care about: a course with no group
    // behind it is a course they will never hear about.
    const covered = new Set(live.map((group) => group.defaultCourseKey).filter(Boolean))
    const missing = user.courseKeys.filter((key) => !covered.has(key))
    // A group with no course set can still carry any of them, so "I won't hear
    // anything from those" would be false — it just cannot be promised in advance.
    const open = live.some((group) => !group.defaultCourseKey)
    const gap = missing.length
      ? open
        ? `\n\n No group is pinned to ${missing.map(courseDisplay).join(', ')}, but I work out the course per message in the ones above — so I'll pick them up if they come up there.`
        : `\n\n⚠️ Nothing connected yet for ${missing.map(courseDisplay).join(', ')} — I won't hear anything from those.`
      : ''
    return `${reading}${gap}`
  }

  const pendingLines = waiting
    .map((group) => {
      const suggested = group.proposedCourse ?? group.defaultCourse
      return `• ${group.name ?? group.chatJid}${suggested ? ` — someone says it's ${suggested}` : ''}`
    })
    .join('\n')

  const next = isOperator
    ? `\n\nSend *approve <course>* to start reading ${waiting.length === 1 ? 'it' : 'them'}.`
    : `\n\nThe operator has to approve ${waiting.length === 1 ? 'it' : 'them'} before I read anything.`

  return `${reading}\n\n*Waiting for approval:*\n${pendingLines}${next}`
}

/**
 * The one that has to be specific.
 *
 * A student who added the bot cannot approve it, and telling them the command would
 * have them typing something that does nothing — so the two answers are different,
 * not the same answer with a caveat.
 */
async function approving({ isOperator }: Context): Promise<string> {
  const waiting = await groupRepository.pending()

  if (!isOperator) {
    if (waiting.length === 0) {
      return `Approving a group is the operator's call — whoever set me up. Nothing is waiting for them right now.

If you've added me to a group, tell me which course it's for and I'll pass it on.`
    }
    return `Approving a group is the operator's call — whoever set me up, not me and not you. Anybody can add me to any chat, so somebody has to say it's really a course group.

Tell me which course it's for and I'll pass that on, so they're not deciding blind.`
  }

  if (waiting.length === 0) {
    const live = await groupRepository.approved()
    return live.length > 0
      ? `Nothing is waiting for approval — I'm already reading ${live.length} group${live.length === 1 ? '' : 's'}. Send *groups* to see them.`
      : `Nothing is waiting for approval yet. Add me to a course group and I'll ask you about it.`
  }

  const lines = waiting.map((group) => {
    const suggested = group.proposedCourse ?? group.defaultCourse
    const who = group.proposedBy ? ` _(${group.proposedBy} says so)_` : ''
    return suggested
      ? `• *${group.name ?? group.chatJid}* → send *approve ${suggested}*${who}`
      : `• *${group.name ?? group.chatJid}* → send *approve <course code>*, like *approve CVE 575*`
  })

  return `Right here, in this chat — not in the group. I don't read a group until it's approved, and I never post in one.

${lines.join('\n')}

*approve* on its own works too, and I'll use the course above. *ignore group* leaves it alone.`
}

function courses({ user }: Context): string {
  const watching = user.courseKeys.length
    ? `\n\nRight now: ${user.courseKeys.map(courseDisplay).join(', ')}.`
    : ''
  return `*add MTH 101* — start watching a course
*remove STA 202* — stop watching one
*my courses* — see the list

You can do both at once: *add MTH 101 and remove STA 202*.${watching}`
}

function resources({ user }: Context): string {
  const example = courseDisplay(user.courseKeys[0] ?? '') ?? 'CSC 301'
  return `Ask for them by course: *${example} resources* — I'll send the actual files, not links.

You can narrow it: *${example} slides*, or *past questions*. If there are a lot I'll list them first, and you can say *send 2* or *send all*.

I only have what people shared in the group after I joined.`
}

function digest({ user }: Context): string {
  const when = formatTime12(`${String(user.digestHour).padStart(2, '0')}:00`) ?? '7am'
  return `One message each morning with everything across your courses. Yours arrives at *${when}*.

*settings* — see it
*settings 6am voice* — change the time, or get it as a voice note too
*stop the morning digest* — turn it off, keeping the instant alerts`
}

function quiet(): string {
  return `*pause* — go quiet until you say otherwise
*pause until Monday* · *pause for 2 days* — go quiet for a while
*mute STA 202* — stop the pings for one course
*only urgent* — tests, deadlines and venue changes only
*quiet off* — stop holding alerts overnight
*resume* — back to normal

Nothing is lost while I'm quiet: it all turns up in your next digest.`
}

function general({ isOperator }: Context): string {
  const operator = isOperator
    ? `\n\nAs the operator you also have *admin* — approving groups, setting courses, naming who to trust.`
    : ''
  return `I sit in your course groups and DM you what matters — test dates, venue changes, deadlines, the voice notes nobody plays. I never post in a group.

Ask me things like *"when is the CSC 301 test?"* or *"CSC 301 resources"*, and send *help* for the full list.${operator}`
}

export const guidanceService = new GuidanceService()
