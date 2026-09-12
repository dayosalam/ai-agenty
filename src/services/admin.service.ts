import { config } from '../config.js'
import { groupRepository, pendingRepository, userRepository } from '../repositories/index.js'
import type { Authority } from '../models/index.js'
import { courseDisplay, parseCourseList } from '../utils/courses.js'
import { formatTime12 } from '../utils/dates.js'
import { hourIn, isQuietHour } from '../utils/quiet.js'
import { announcementService } from './announcement.service.js'
import { digestService } from './digest.service.js'
import { samePhone } from '../whatsapp/jid.js'
import { groupService } from './group.service.js'

const SET = /^set\s+(\d+)\s+(.+)$/i
const APPROVE = /^approve\s*(.*)$/i
const REJECT = /^(ignore|reject|decline)\s+group\s*(\d*)$/i
const TRUST = /^trust\s+(\d+)\s+(.+?)\s+as\s+(lecturer|rep|class\s*rep|student)$/i
const ALWAYS = /^always\b/i
const IGNORE = /^(ignore|skip|no)$/i

const ADMIN_HELP = `*Operator commands*

*approve CSC 301* — start reading a group waiting for approval
*trust 1 Dr. Bello as lecturer* — whose word settles things
*trust 1 Chidi as rep* — the class rep
*ignore group* — stay silent in it
*status* — whether announcements can actually reach anyone
*groups* — every group I'm in and its course
*set 1 CSC 301* — give a group a course (*set 1 none* clears it)
*pending* — announcements waiting for a course
*retry failed* — reprocess anything that errored
*digest now* — send the morning digest immediately

When I can't tell which course an announcement is for, I'll ask. Reply with the code, *always <code>* to set the whole group, or *ignore*.

You can still use me as a student — *help* shows those commands.`

/**
 * Operator commands, in the same DM thread as everything else. There is no web
 * frontend and the PRD rules one out, so group setup happens over WhatsApp too.
 */
export class AdminService {
  isOperator(phone: string): boolean {
    return config.admin.phones.some((operator) => samePhone(phone, operator))
  }

  /**
   * Operator-shaped, whoever sent it.
   *
   * A student typing "approve CVE 575" otherwise falls through to the model, which
   * searches the group archive for an announcement about approving things and
   * reports it heard nothing — a reply that reads as broken rather than as refused.
   */
  looksLikeOperatorCommand(text: string): boolean {
    return /^(approve|ignore\s+group|reject\s+group|trust\s+\d|set\s+\d+\s|pending|retry\s+failed|groups?|status|admin)\b/i.test(
      text.trim(),
    )
  }

  /** Returns a reply, or null when the text is not an operator command. */
  async handle(text: string): Promise<string | null> {
    const trimmed = text.trim()

    if (/^(admin|admin help)$/i.test(trimmed)) return ADMIN_HELP

    const rejecting = REJECT.exec(trimmed)
    if (rejecting) return this.rejectGroup(Number(rejecting[2] || '1'))

    const approving = APPROVE.exec(trimmed)
    if (approving) return this.approveGroup(approving[1]!.trim())

    const trusting = TRUST.exec(trimmed)
    if (trusting) {
      return this.trustSender(Number(trusting[1]), trusting[2]!.trim(), trusting[3]!)
    }
    if (/^groups?$/i.test(trimmed)) return this.list()
    if (/^status$/i.test(trimmed)) return this.status()
    if (/^retry\s+failed$/i.test(trimmed)) return this.retry()
    if (/^digest\s+now$/i.test(trimmed)) return this.digestNow()
    if (/^pending$/i.test(trimmed)) return this.pending()

    const match = SET.exec(trimmed)
    if (match) return this.set(Number(match[1]), match[2]!.trim())

    // Answering an outstanding "which course is this?" question. Checked last so it
    // never shadows a real command, and only when a question is actually open.
    return this.answerPending(trimmed)
  }

  /**
   * Resolves the oldest unanswered question about an announcement with no course.
   *
   * A bare course code means nothing on its own — it is only an answer because
   * something was asked. Without an open question this returns null and the text
   * falls through to ordinary handling.
   */
  private async answerPending(text: string): Promise<string | null> {
    const [decision] = await pendingRepository.unresolved(1)
    if (!decision) return null

    if (IGNORE.test(text)) {
      await pendingRepository.resolve(decision.eventId, null)
      return `Ignored. I'll leave that one alone.`
    }

    const always = ALWAYS.test(text)
    const [key] = parseCourseList(text)
    if (!key) return null

    const course = courseDisplay(key) ?? key
    await pendingRepository.resolve(decision.eventId, course)
    const students = await announcementService.deliverResolved(decision.eventId, course)

    const told =
      students > 0
        ? `Sent it to ${students} student${students === 1 ? '' : 's'} taking ${course}.`
        : `Nobody is registered for ${course} yet, so there was no one to tell — but it's filed now.`

    if (!always) {
      return `Filed under *${course}*. ${told}\n\nSend *always ${course}* if everything from *${decision.groupName ?? 'that group'}* belongs to it.`
    }

    await groupService.setCourse(decision.chatJid, course)
    // Everything else that was stuck on this group can now be answered too.
    const rest = await pendingRepository.openForGroup(decision.chatJid)
    for (const other of rest) {
      await pendingRepository.resolve(other.eventId, course)
      await announcementService.deliverResolved(other.eventId, course)
    }

    const backlog =
      rest.length > 0
        ? ` Also cleared ${rest.length} earlier one${rest.length === 1 ? '' : 's'} from that group.`
        : ''
    return `Done — *${decision.groupName ?? decision.chatJid}* is now *${course}*, and I'll file everything from it there. ${told}${backlog}`
  }

  /**
   * Starts reading a group.
   *
   * Nothing was stored before this point, so approval is the moment Peermate is
   * first allowed to see anything said there — see PRD §7.
   */
  private async approveGroup(rest: string): Promise<string> {
    const [group] = await groupRepository.pending()
    if (!group) {
      return "No group is waiting for approval. Send *groups* to see the ones I'm already in."
    }

    // Fall back to what a student proposed, then to the guess from the group name.
    const [key] = parseCourseList(rest)
    const course = key
      ? (courseDisplay(key) ?? null)
      : (group.proposedCourse ?? group.defaultCourse)
    await groupService.approve(group.chatJid, course)

    const tail = course
      ? `Everything from it will be filed under *${course}*.`
      : `I couldn't tell which course it is, so I'll work it out per message and ask when I can't.`

    const more = (await groupRepository.pending()).length
    const queue = more > 0 ? `\n\n${more} more waiting — send *approve <course>* again.` : ''

    return `✅ Now listening to *${group.name ?? group.chatJid}*. ${tail}${queue}`
  }

  private async rejectGroup(position: number): Promise<string> {
    const pendingGroups = await groupRepository.pending()
    const group = pendingGroups[position - 1]
    if (!group) return 'No group is waiting for approval.'

    await groupService.ignore(group.chatJid)
    return `Ignored *${group.name ?? group.chatJid}*. I'll stay in it but read nothing.`
  }

  /**
   * Records whose word settles things in a group.
   *
   * Matched on the name as it appears in the chat, because group participants now
   * arrive as opaque LIDs and the operator knows "Dr. Bello", not a phone number.
   */
  private async trustSender(position: number, name: string, role: string): Promise<string> {
    const groups = await groupRepository.all()
    const group = groups[position - 1]
    if (!group) return `There's no group ${position}. Send *groups* to see the list.`

    const authority: Authority = /lecturer/i.test(role)
      ? 'lecturer'
      : /rep/i.test(role)
        ? 'rep'
        : 'student'

    await groupService.trust(group.chatJid, name, authority)
    const label = authority === 'rep' ? 'class rep' : authority

    return `Got it — *${name}* is the ${label} in *${group.name ?? group.chatJid}*.

When they announce something I'll say so. When someone else repeats it, I'll record that quietly instead of sending you the same thing twice.`
  }

  /**
   * Runs the morning digest now.
   *
   * The digest is one of the two things worth showing, and it fires once a day at
   * an hour nobody is recording at. Without this the only way to see it is to change
   * the clock.
   */
  private async digestNow(): Promise<string> {
    const students = await userRepository.allRegistered()
    if (students.length === 0) return 'Nobody is registered, so there is no digest to send.'

    await digestService.runForAll()
    return `Sent the digest to ${students.length} student${students.length === 1 ? '' : 's'}.`
  }

  private async retry(): Promise<string> {
    const { retryFailed } = await import('../workers/ingest.worker.js')
    const count = await retryFailed()
    return count === 0
      ? 'Nothing has failed — there is nothing to retry.'
      : `Retrying ${count} failed message${count === 1 ? '' : 's'}. I'll send anything I find.`
  }

  private async pending(): Promise<string> {
    const open = await pendingRepository.unresolved()
    if (open.length === 0) return 'Nothing is waiting on me. Every announcement found a course.'

    const lines = open.map(
      (decision, index) =>
        `${index + 1}. *${decision.groupName ?? decision.chatJid}* — _"${decision.summary}"_`,
    )
    return `${open.length} announcement${open.length === 1 ? '' : 's'} waiting for a course:\n\n${lines.join('\n')}\n\nReply with the course code to file the first one.`
  }

  /**
   * Why a message did or did not get delivered.
   *
   * Every link in the chain has to hold — the group must map to a course, and some
   * student must be registered for that course. When one is missing the symptom is
   * silence, which looks identical to a broken pipeline. This shows which link.
   */
  private async status(): Promise<string> {
    const groups = await groupRepository.all()
    const students = await userRepository.allRegistered()

    const covered = new Set(students.flatMap((student) => student.courseKeys))
    const lines: string[] = ['*Delivery check*', '']

    const waiting = groups.filter((group) => group.status === 'pending')
    const live = groups.filter((group) => group.status === 'approved')

    lines.push(`*Groups I'm reading:* ${live.length}`)
    for (const group of live) {
      const course = group.defaultCourse ? `→ ${group.defaultCourse}` : '→ ⚠️ no course set'
      lines.push(`• ${group.name ?? group.chatJid} ${course}`)
    }

    if (waiting.length > 0) {
      lines.push('', `⏳ *Waiting for approval:* ${waiting.length}`)
      for (const group of waiting) {
        lines.push(`• ${group.name ?? group.chatJid} — reading nothing until you approve`)
      }
    }

    // The quiet-hours trap: everything is wired correctly, nothing arrives, and the
    // logs say "not sending". Worth a line before anyone starts debugging the socket.
    const held = students.filter((student) => isQuietHour(student))
    if (held.length > 0) {
      const hour = hourIn(config.digest.timezone)
      lines.push(
        '',
        `🌙 It's ${formatTime12(`${String(hour).padStart(2, '0')}:00`)} — instant alerts are being held for ${held.length} student${held.length === 1 ? '' : 's'} and will arrive in their digest.`,
        'They can send *quiet off* if they want them now.',
      )
    }

    const paused = students.filter((student) => student.paused || student.pausedUntil)
    if (paused.length > 0) {
      lines.push(
        `⏸️ ${paused.length} student${paused.length === 1 ? ' has' : 's have'} alerts paused.`,
      )
    }

    lines.push('', `*Registered students:* ${students.length}`)
    if (students.length === 0) {
      lines.push('⚠️ Nobody is registered, so nothing can be delivered to anyone.')
    }
    for (const student of students) {
      const courses = student.courseKeys.map(courseDisplay).filter(Boolean).join(', ')
      lines.push(`• ${student.name ?? student.phone} — ${courses || '⚠️ no courses'}`)
    }

    const orphans = live
      .filter((group) => group.defaultCourseKey && !covered.has(group.defaultCourseKey))
      .map((group) => group.defaultCourse)
    if (orphans.length > 0) {
      lines.push('', `⚠️ Nobody is registered for: ${orphans.join(', ')}`)
      lines.push('Announcements from those groups will be stored but delivered to nobody.')
    }

    const unset = live.filter((group) => !group.defaultCourseKey).length
    if (unset > 0) {
      lines.push(
        '',
        `⚠️ ${unset} group${unset === 1 ? '' : 's'} with no course. Announcements there only reach people if the message itself names the course. Fix with *set <number> <course>*.`,
      )
    }

    return lines.join('\n')
  }

  private async list(): Promise<string> {
    const groups = await groupRepository.all()
    if (groups.length === 0) return "I'm not in any groups yet. Add me to one and I'll tell you."

    const lines = groups.map((group, index) => {
      const course = group.defaultCourse
        ? `*${group.defaultCourse}*`
        : group.proposedCourse
          ? `_${group.proposedCourse}, proposed by ${group.proposedBy ?? 'a student'}_`
          : '_no course set_'
      const state = group.status === 'approved' ? '' : ` _(${group.status})_`
      const trusted = group.trustedSenders.length
        ? `\n   trusted: ${group.trustedSenders.map((t) => `${t.name} (${t.role === 'rep' ? 'class rep' : t.role})`).join(', ')}`
        : ''
      return `${index + 1}. ${group.name ?? group.chatJid} → ${course}${state}${trusted}`
    })
    return `I'm in ${groups.length} group${groups.length === 1 ? '' : 's'}:\n\n${lines.join('\n')}\n\nChange one with *set <number> <course>*.`
  }

  private async set(position: number, value: string): Promise<string> {
    const groups = await groupRepository.all()
    const group = groups[position - 1]
    if (!group) return `There's no group ${position}. Send *groups* to see the list.`

    const clearing = /^(none|null|clear)$/i.test(value)
    const course = clearing ? null : (courseDisplay(value) ?? value)
    await groupService.setCourse(group.chatJid, course)

    if (clearing) {
      return `Cleared. Messages from *${group.name ?? group.chatJid}* will need to name their own course.`
    }

    // Anything that was waiting on this group now has its answer.
    const waiting = await pendingRepository.openForGroup(group.chatJid)
    for (const decision of waiting) {
      await pendingRepository.resolve(decision.eventId, course!)
      await announcementService.deliverResolved(decision.eventId, course!)
    }
    const backlog =
      waiting.length > 0
        ? ` Also delivered ${waiting.length} announcement${waiting.length === 1 ? '' : 's'} that were waiting on it.`
        : ''

    return `Done — *${group.name ?? group.chatJid}* is now *${course}*.${backlog}`
  }
}

export const adminService = new AdminService()
