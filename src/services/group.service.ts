import { config } from '../config.js'
import { logger } from '../core/logger.js'
import type { Authority, Group } from '../models/index.js'
import { groupRepository, pendingRepository } from '../repositories/index.js'
import { courseDisplay, courseKey, parseCourseList } from '../utils/courses.js'
import { jidToPhone, phoneToJid } from '../whatsapp/jid.js'
import { notifierService } from './notifier.service.js'

export interface GroupContext {
  subject: string | null
  addedBy?: string | null
  addedByName?: string | null
  participantCount?: number | null
}

/**
 * Being added to a group is not permission to read it.
 *
 * Anybody can add this number to any group — a private chat, a hostel group, a
 * family thread — and until tonight Peermate would transcribe, embed and store
 * everything said there. A group now ingests nothing until the operator approves
 * it, which is what PRD §7 always claimed was true.
 */
export class GroupService {
  /** Records the group as pending and asks the operator about it. Never ingests. */
  async register(chatJid: string, context: GroupContext): Promise<Group> {
    const existing = await groupRepository.findByJid(chatJid)
    if (existing) {
      // A rename can reveal the course after the fact; the decision still stands.
      if (context.subject && context.subject !== existing.name) {
        await groupRepository.upsert({ ...existing, name: context.subject })
      }
      return existing
    }

    const guess = this.courseFromSubject(context.subject)
    const group: Group = {
      chatJid,
      name: context.subject,
      defaultCourse: guess,
      defaultCourseKey: courseKey(guess),
      status: 'pending',
      addedBy: context.addedBy ?? null,
      addedByName: context.addedByName ?? null,
      participantCount: context.participantCount ?? null,
      trustedSenders: [],
      proposedCourse: null,
      proposedBy: null,
      joinedAt: new Date(),
      approvedAt: null,
    }
    await groupRepository.upsert(group)
    logger.info({ chatJid, subject: context.subject, guess }, 'group pending approval')

    await this.askOperator(group)
    return group
  }

  async approve(chatJid: string, course: string | null): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = {
      ...group,
      status: 'approved',
      defaultCourse: course,
      defaultCourseKey: courseKey(course),
      approvedAt: new Date(),
    }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, course }, 'group approved')
    return updated
  }

  async ignore(chatJid: string): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = { ...group, status: 'ignored' }
    await groupRepository.upsert(updated)

    // Nothing from it was stored, so there is nothing to clean up but the questions.
    for (const decision of await pendingRepository.openForGroup(chatJid)) {
      await pendingRepository.resolve(decision.eventId, null)
    }
    logger.info({ chatJid }, 'group ignored — staying silent')
    return updated
  }

  /**
   * Records whose word settles a question in this group.
   *
   * Without it every sender is equal, so a lecturer's correction and a classmate's
   * half-remembered version arrive as two separate alerts of the same weight.
   */
  async trust(chatJid: string, name: string, role: Authority): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null

    const others = group.trustedSenders.filter(
      (sender) => sender.name.toLowerCase() !== name.toLowerCase(),
    )
    const updated: Group = {
      ...group,
      trustedSenders: [...others, { name, jid: null, role }],
    }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, name, role }, 'trusted sender recorded')
    return updated
  }

  /**
   * A student telling Peermate what a group is for.
   *
   * They cannot approve it — anybody can add the bot anywhere, so approval stays
   * with the operator. But they are the one who knows, and throwing that away means
   * the operator is guessing about a group they have never seen.
   */
  async propose(chatJid: string, course: string, by: string): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null

    await groupRepository.upsert({ ...group, proposedCourse: course, proposedBy: by })
    logger.info({ chatJid, course, by }, 'course proposed for group')

    if (config.admin.phone) {
      await notifierService
        .sendText(
          phoneToJid(config.admin.phone),
          `💡 *${by}* says *${group.name ?? chatJid}* is the group for *${course}*.

It's still waiting on you. Reply *here* with *approve ${course}* to start reading it, or *ignore group*.

⚠️ Replying inside the group won't work — I don't read a group until it's approved.`,
        )
        .catch((error) => logger.error({ err: error }, 'could not relay proposal'))
    }
    return group
  }

  async setCourse(chatJid: string, course: string | null): Promise<Group | null> {
    const group = await groupRepository.findByJid(chatJid)
    if (!group) return null
    const updated: Group = { ...group, defaultCourse: course, defaultCourseKey: courseKey(course) }
    await groupRepository.upsert(updated)
    logger.info({ chatJid, course }, 'group course set')
    return updated
  }

  /** "CSC 301 — 2025/26 Class" -> "CSC 301". Null when the name carries no code. */
  private courseFromSubject(subject: string | null): string | null {
    if (!subject) return null
    const [first] = parseCourseList(subject)
    return first ? (courseDisplay(first) ?? null) : null
  }

  /**
   * Peermate never messages a student who has not written first. The operator is the
   * one exception: they configured the bot, and this is the only way to ask.
   */
  private async askOperator(group: Group): Promise<void> {
    if (!config.admin.phone) {
      logger.warn(
        { chatJid: group.chatJid },
        'no ADMIN_PHONE set — this group can never be approved and will stay silent',
      )
      return
    }

    const who = group.addedByName ?? (group.addedBy ? jidToPhone(group.addedBy) : null)
    const facts = [
      `*Group:* ${group.name ?? 'unnamed'}`,
      who ? `*Added by:* ${who}` : null,
      group.participantCount ? `*Members:* ${group.participantCount}` : null,
      group.defaultCourse
        ? `*Looks like:* ${group.defaultCourse} (from the name)`
        : `*Course:* I can't tell from the name`,
    ]
      .filter(Boolean)
      .join('\n')

    const suggestion = group.defaultCourse
      ? `*approve ${group.defaultCourse}*`
      : '*approve CSC 301*'

    await notifierService.sendText(
      phoneToJid(config.admin.phone),
      `📎 I've been added to a group.

${facts}

I'm *not reading anything* from it yet. Reply *here, in this chat*:
• ${suggestion} — start listening, file it under that course
• *approve* — start listening, but I'll work out the course per message
• *ignore group* — stay silent in it

⚠️ Sending that inside the group won't work — I don't read a group until it's approved, and I never post in one.`,
    )
  }
}

export const groupService = new GroupService()
