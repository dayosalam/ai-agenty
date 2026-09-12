/**
 * Clears the Signal session for one contact so it renegotiates from scratch.
 *
 * The symptom this fixes is "Waiting for this message. This may take a while." on
 * the handset, with `Bad MAC` and `Closing open session in favor of incoming prekey
 * bundle` in the log. It means Peermate's ratchet for that contact and the phone's
 * have diverged, and every message sent across the gap is undecryptable for good.
 *
 * Deleting a session file is not destructive: Signal re-establishes one on the next
 * message. Credentials, pre-keys and app-state keys are untouched, so the bot stays
 * paired — this is not a re-pair.
 *
 * The process must be stopped first, or it will write its in-memory session straight
 * back out and undo this.
 *
 * Run with: npx tsx src/scripts/repair-session.ts 210260258201705 2349021527907
 */
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { config } from '../config.js'

const wanted = process.argv.slice(2).map((value) => value.replace(/\D/g, ''))
const files = readdirSync(config.whatsapp.authDir).filter((name) => name.startsWith('session-'))

if (wanted.length === 0) {
  console.log('Sessions currently held:\n')
  for (const name of files.sort()) console.log(`  ${name}`)
  console.log('\nPass the identifiers to clear, e.g.:')
  console.log('  npx tsx src/scripts/repair-session.ts 210260258201705 2349021527907\n')
  process.exit(0)
}

const doomed = files.filter((name) => wanted.some((id) => name.includes(id)))
if (doomed.length === 0) {
  console.log('No session files match. Run with no arguments to list what is there.')
  process.exit(1)
}

for (const name of doomed) {
  unlinkSync(join(config.whatsapp.authDir, name))
  console.log(`cleared ${name}`)
}
console.log(
  `\n${doomed.length} session(s) cleared. Start the bot and send a message to re-establish.\n`,
)
