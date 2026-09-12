import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'
import { config } from '../config.js'
import { logger } from '../core/logger.js'
import { isBroadcastJid, isGroupJid } from './jid.js'

export type MessageHandler = (message: WAMessage) => void
export interface GroupJoinInfo {
  subject: string | null
  addedBy?: string | null
  addedByName?: string | null
  participantCount?: number | null
}
export type GroupJoinHandler = (chatJid: string, info: GroupJoinInfo) => void

let sock: WASocket | null = null
let reconnecting = false
let attempts = 0

const handlers: MessageHandler[] = []
const groupHandlers: GroupJoinHandler[] = []

export function onMessage(handler: MessageHandler): void {
  handlers.push(handler)
}

export function onGroupJoin(handler: GroupJoinHandler): void {
  groupHandlers.push(handler)
}

export function getSocket(): WASocket {
  if (!sock)
    throw new Error('WhatsApp socket not connected — call connectWhatsApp() during startup')
  return sock
}

/**
 * Tears the old socket down before a new one replaces it.
 *
 * Without this the previous socket keeps its listeners and its keep-alive running.
 * Two live sockets on one session is the state that leaves Baileys reporting
 * "connected" while its init queries time out and no message is ever delivered —
 * the process looks healthy and silently ingests nothing.
 */
function dispose(previous: WASocket | null): void {
  if (!previous) return
  try {
    previous.ev.removeAllListeners('connection.update')
    previous.ev.removeAllListeners('messages.upsert')
    previous.ev.removeAllListeners('groups.upsert')
    previous.ev.removeAllListeners('groups.update')
    previous.ev.removeAllListeners('creds.update')
    previous.end(undefined)
  } catch (error) {
    logger.debug({ err: error }, 'error disposing previous socket')
  }
}

export async function connectWhatsApp(): Promise<WASocket> {
  const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.authDir)
  const { version } = await fetchLatestBaileysVersion()

  dispose(sock)

  // Baileys logs every protocol frame at debug, and reports a failed optional init
  // query at error level on most connects — alarming, and harmless. Our own
  // connection handling covers the failures that matter.
  const baileysLogger = logger.child({ module: 'baileys' }, { level: config.baileysLogLevel })

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    // Peermate is a reader. Announcing presence would make a silent number look active.
    markOnlineOnConnect: false,
    syncFullHistory: false,
  })

  const current = sock

  current.ev.on('creds.update', saveCreds)

  current.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      logger.info('scan this QR with the bot number: WhatsApp > Linked devices')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      attempts = 0
      reconnecting = false
      logger.info({ jid: current.user?.id }, 'whatsapp connected')
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output
        ?.statusCode

      // A logged-out session cannot be revived by reconnecting — retrying loops forever.
      // Stop and make the operator re-pair by hand. See PRD §11.
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error(
          { authDir: config.whatsapp.authDir },
          'logged out — delete the auth dir and re-pair; not reconnecting',
        )
        return
      }

      // Only the socket that is currently live may trigger a reconnect; a disposed
      // one firing late would spawn a second connection.
      if (current !== sock || reconnecting) return
      reconnecting = true
      attempts += 1
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts, 5))
      logger.warn({ statusCode, attempts, delay }, 'connection closed, reconnecting')
      setTimeout(() => {
        void connectWhatsApp().catch((error) => {
          reconnecting = false
          logger.error({ err: error }, 'reconnect failed')
        })
      }, delay)
    }
  })

  // Fires when the bot is added to a group. This is how a group registers itself —
  // there is no other moment at which we learn the subject.
  current.ev.on('groups.upsert', (groups) => {
    for (const group of groups) {
      for (const handler of groupHandlers) {
        handler(group.id, {
          subject: group.subject ?? null,
          addedBy: group.owner ?? null,
          participantCount: group.participants?.length ?? null,
        })
      }
    }
  })

  // A rename after the fact still tells us the course, so treat it as a join.
  current.ev.on('groups.update', (updates) => {
    for (const update of updates) {
      if (!update.id || !update.subject) continue
      for (const handler of groupHandlers) handler(update.id, { subject: update.subject })
    }
  })

  // Who performed the add. The operator is deciding whose request to trust, so the
  // name matters more than the group's own metadata.
  current.ev.on('group-participants.update', (update) => {
    if (update.action !== 'add') return
    const me = current.user?.id?.split(':')[0]
    const added = update.participants.some((participant) => participant.split(':')[0] === me)
    if (!added) return
    for (const handler of groupHandlers) {
      handler(update.id, { subject: null, addedBy: update.author ?? null })
    }
  })

  current.ev.on('messages.upsert', ({ messages, type }) => {
    // Visibility: without this, "nothing happened" is indistinguishable from
    // "nothing arrived", which is the hardest failure here to diagnose.
    logger.info(
      { type, count: messages.length, kinds: messages.map((m) => Object.keys(m.message ?? {})[0]) },
      'messages.upsert',
    )

    // 'append' carries messages the linked phone itself sent, which is how a lecturer
    // testing from their own handset appears. Ignoring it loses real announcements;
    // the unique index makes accepting both types harmless.
    if (type !== 'notify' && type !== 'append') return

    for (const message of messages) {
      const jid = message.key.remoteJid

      // Status posts arrive looking exactly like messages. Treated as a DM they
      // create a "student" called status and get replied to — which publishes a
      // Status update to the account's contacts.
      if (isBroadcastJid(jid)) {
        logger.debug({ jid }, 'ignoring broadcast/status')
        continue
      }

      // Our own DMs are the notifications we just sent — ingesting them would loop.
      // In a group, though, a message from this account is a real participant
      // talking, and skipping it is why testing from the linked phone looked broken.
      if (message.key.fromMe && !isGroupJid(jid)) {
        logger.debug({ id: message.key.id }, 'skipping own dm')
        continue
      }

      for (const handler of handlers) handler(message)
    }
  })

  // Pairing code instead of a QR scan: WhatsApp > Linked devices > Link with phone
  // number. The phone is still required once — a linked device is a credential the
  // account issues, so there is no token that substitutes for it.
  if (!current.authState.creds.registered && config.whatsapp.pairingNumber) {
    const number = config.whatsapp.pairingNumber.replace(/\D/g, '')
    // The socket must finish opening before it can ask for a code.
    setTimeout(() => {
      void current
        .requestPairingCode(number)
        .then((code) => logger.info({ number }, `pairing code: ${code}`))
        .catch((error) => logger.error({ err: error }, 'could not request pairing code'))
    }, 3000)
  }

  return current
}
