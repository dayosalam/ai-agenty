# Peermate

## Project Overview

An agent that reads university WhatsApp class group chats and DMs registered students
what they missed, with citations. One shared bot number serves a whole class. It posts
nothing in any group and speaks only in 1:1 DMs.

[PRD.md](PRD.md) is the specification and records why each architectural choice was
made. Read it before proposing a different one.

## Related Projects

| Project | Role | Path |
|---------|------|------|
| unimart-api | `formatPhoneAsChatID` — the phone normalisation this ports, in Go | `/Users/salami/Desktop/Startup/unimart-api` |
| uniwrite-api | Pattern source for the layering (Python, not a stack reference) | `/Users/salami/Desktop/Startup/uniwrite-api` |

## Tech Stack

- **Runtime:** Node 20+, TypeScript, ESM (`"type": "module"` — relative imports need `.js`)
- **WhatsApp:** Baileys (`@whiskeysockets/baileys`) — in-process socket, no webhook
- **HTTP:** Express — health and operator routes only
- **Database:** MongoDB (official `mongodb` driver)
- **Vector DB:** Chroma (`chromadb` v3 client, HTTP — server required)
- **Storage:** MinIO (voice notes, images, course documents)
- **AI:** OpenAI — Whisper for voice notes, structured outputs for extraction
- **Embeddings:** `text-embedding-3-small`, 1536-dim
- **Testing:** vitest
- **Config:** zod-validated env over `src/data/defaults.json`

## Commands

```bash
npm run dev          # tsx watch — prints the pairing QR on first run
npm run build        # tsc -> dist/
npm test             # vitest
npm run typecheck    # tsc over src *and* tests
npm run infra:up     # docker compose (mongo, minio, chroma)
```

No Docker on this machine — see [README.md](README.md) for the direct-daemon fallback.

## Project Structure

```
src/
├── index.ts             # Boots db -> socket -> queue -> http; handles SIGINT
├── config.ts            # zod-validated env over data/defaults.json
├── core/                # logger.ts (pino), errors.ts
├── db/                  # mongo.ts (owns indexes), chroma.ts, minio.ts
├── models/              # zod schemas — message.ts is the contract
├── repositories/        # One per collection, all extending base.repository.ts
├── services/            # notifier.service.ts is the only module that sends;
│                        # document-reader.service.ts reads pdf/docx/scans;
│                        # cloud-api.service.ts is the PRD §8 fallback, unused today
├── scheduler/           # node-cron — digest + deadline warnings at 07:00 Lagos
├── scripts/             # smoke.ts — full pipeline against real OpenAI, no WhatsApp
├── whatsapp/            # socket.ts (Baileys), normalizer.ts, jid.ts
├── workers/             # queue.ts (bounded concurrency), ingest.worker.ts
├── http/                # server.ts — health + admin only
└── utils/               # courses.ts (canonical keys), dates.ts (calendar window)
```

The superseded Python prototype is out of this repo entirely, at
`/Users/salami/Desktop/Startup/peermate/legacy-python`. Nothing here imports it.

## Invariants

These are decisions, not defaults. Changing one changes the product.

- **`messages` and `extractions` are append-only.** A correction is a new row. Never
  update an existing extraction, and never resolve conflicts at write time.
- **Peermate never posts in a group.** Every send goes through
  [NotifierService](src/services/notifier.service.ts), which throws `GroupSendForbidden`
  on a `@g.us` JID. Do not add a second send path that bypasses it.
- **Peermate never messages someone who has not messaged it first.** Baileys can list
  group participants; that list must not become users.
- **Dedupe before any paid work.** `insertIfNew` returns false for an already-ingested
  message and the worker stops there. WhatsApp re-delivers on reconnect, so without
  this a reconnect re-transcribes and re-notifies everything.
- **Nothing may throw into the socket handler.** An unhandled rejection takes WhatsApp
  ingestion down with it. The queue catches per item; keep it that way.
- **Extraction always decides `kind` first.** The tagged union in
  [src/models/extraction.ts](src/models/extraction.ts) is what stops noise becoming a
  phantom announcement. Do not flatten it into nullable fields.
- **One message can yield several announcements.** A timetable photo carries a week of
  them. Extraction returns a list and each entry becomes its own row sharing the source
  message's provenance — never merge them into one summary record.
- **The model never calculates a date.** `calendarWindow()` computes the real days and
  the extractor picks one; anything outside that list is dropped to null. Asked what
  "this Friday" meant on a Friday, the model returned a Tuesday. See
  [src/utils/dates.ts](src/utils/dates.ts).
- **Course matching is always on `courseKey`.** `courseKey('csc 301') === 'CSC301'`.
  Matching on the display string returns nothing and raises nothing, so a student
  silently stops hearing from Peermate. See [src/utils/courses.ts](src/utils/courses.ts).
- **JIDs are built in one place.** Individuals are `@s.whatsapp.net`, never Green API's
  `@c.us`. A wrong suffix raises nothing — the DM is simply never delivered. See
  [src/whatsapp/jid.ts](src/whatsapp/jid.ts).
- **A document is filed before it is read.** DocumentService tags every file; the
  reader is a second pass that may fail without consequence. A file that cannot be
  read is indexed as unreadable rather than skipped, so students are told the truth
  instead of being told it does not exist. Chunking happens *within* one file only —
  no embedding ever blends two senders.
- **Retrieval favours recall.** Read-time conflict resolution can only compare records
  retrieval returned, so filter by course and window, then take a generous k.
- **Citations come from stored provenance, not from the model.** Sender, timestamp and
  source message id ride on the row; the LLM phrases the answer, it does not supply
  the attribution.
- **Every unsolicited message goes through
  [DeliveryService](src/services/delivery.service.ts).** Pauses, per-course mutes,
  urgent-only, quiet hours and mid-conversation deferral are decided there and
  nowhere else. A student who asked to be left alone and is messaged anyway does not
  give a second chance, and a rule applied in three services will be missed in the
  fourth. Answers to a question the student just asked are not unsolicited and do not
  pass through it.
- **Nothing a delivery rule holds is ever discarded.** The digest covers everything
  since it last ran, and `lastDigestAt` is not advanced when a digest is held — so a
  pause defers and never deletes. Reversal of PRD §8's original "no toggles"; see §8.
- **A group is silent until approved.** Being added to a chat is not consent from the
  people in it. `pending` groups are ingested from not at all — see
  [GroupService](src/services/group.service.ts).
- **A repeat is corroboration, not news.** `findSimilar` matches only on stated
  values; nulls stay open so a fuller telling enriches the first row rather than
  creating a second. Only a more authoritative speaker turns a repeat into a DM.
- **The extractor reads only what somebody said** — text, caption or transcript. A
  filename is not an announcement. See `readableContent` and
  [tests/extraction-content.test.ts](tests/extraction-content.test.ts).
- **`auth_state/` is a live WhatsApp session credential.** Gitignored. Never commit it,
  never bake it into an image, never run two processes against it.

## Conventions

- Comments explain *why*, never *what*. If the code says it, don't restate it.
- Repositories own all Mongo access; services never touch a collection directly.
- Every pipeline stage fails soft — a message that cannot be transcribed is still a
  stored message, and the digest still goes out.
- Env booleans go through `booleanFromEnv` in [src/config.ts](src/config.ts).
  `z.coerce.boolean()` is `Boolean(string)`, so `"false"` would coerce to `true`.
