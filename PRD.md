# Peermate — PRD

**Submission title:** Peermate: A Personal Agent That Lives in Your Class Group Chats
**Tagline:** It listens to the groups so you don't have to.
**Event:** AI Tinkerers "Agents, Everywhere" — Impact Hub Abuja
**Team:** Solo · Node / TypeScript

---

## 1. One-liner

Peermate is an agent that sits silently inside university course group chats, hears the announcements students missed — including voice notes and photographed timetables — and messages each registered student privately with what matters, citing where it came from.

## 2. Problem

A Nigerian university student is in six course groups, a departmental group, and a hostel group. Announcements arrive as 90-second lecturer voice notes nobody plays, photos of handwritten timetables pinned to a noticeboard, and PDFs buried under 300 messages. Venues change. Dates shift. Three classmates spread three different versions.

Nobody scrolls eight groups every morning. So students miss tests.

## 3. Target user

Undergraduates in Nigerian universities. WhatsApp is the primary and often only digital workspace. Cheap Android phones, metered data, mixed English/Pidgin/code-switching.

## 4. What Peermate does

**One bot number, many students.** Peermate is a single WhatsApp number added to course groups. It reads everything those groups say, posts nothing, and speaks only in 1:1 DMs with students who registered with it. One number in `CSC 301` serves every student taking CSC 301.

| Stage | Behaviour |
|---|---|
| **Ingest** | Receives every message in every joined group — text, voice notes, images, PDFs — over a Baileys socket linked to the bot number. |
| **Understand** | Transcribes voice notes (Whisper), reads images (vision), and classifies each message as announcement / question / noise in one call. |
| **Extract** | For announcements: course, event type, date, time, venue — plus source message ID, sender, timestamp. |
| **File** | Every document that lands in a group is tagged to a course and type (slides / past questions / assignment / textbook), stored, and — for PDFs, `.docx` and scans — read, so its contents can be questioned. |
| **Act** | DMs registered students: instant announcement alerts, a daily digest, deadline warnings with the file attached. Answers questions with citations. Sends the actual files back. |

**History is whatever the linked phone chooses to sync.** Baileys links as a companion device to a real WhatsApp account, so on pairing the phone pushes a history sync (`messaging-history.set`, widened by `syncFullHistory`). If the bot number was already in a group, Peermate may inherit that backlog. If the number is added to a group afterwards, WhatsApp gives it nothing prior and knowledge starts at the join.

The sync is best-effort and its depth is not guaranteed, so **the demo is planned as though there were none** (§9). Inherited history is a bonus, never a dependency.

**Students, however, get full history.** A student who registers today can query everything Peermate has stored since it joined their selected course groups, and pull the resource library immediately. For the prototype, course selection is self-reported during onboarding; membership verification is deferred.

## 5. The differentiator

Three moments, all in the video:

**1. It heard what nobody played.** She asks *"when is the CSC 301 test?"* Peermate answers: *Friday 10am, LG7 — from Dr. Bello's voice note, Tuesday 4:12pm.* She never opened that voice note. No chatbox can be in that room while the conversation is still happening.

**2. Eight rooms, one thread.** The digest aggregates every group into a single message. A chatbox can be in zero rooms; Peermate is in all of them.

**3. The library assembled itself.** *"CSC 301 resources"* returns the course's whole shelf — slides from week three, past questions from August, the assignment brief — as actual files, sent back in the DM. Nobody curated it. It exists because Peermate was in the room when each file arrived. A chatbox starts empty every session; you would have to find and upload all forty files yourself, which is the work being avoided.

**The 5/5 line for the submission:**

> This cannot be reproduced in a chatbox. The source material is a live, multi-party, multi-media stream arriving from forty people across eight rooms. There is nothing to upload — the conversation hasn't finished happening.

## 6. Scope

### v1 — the spine (build in this order)

1. Baileys `messages.upsert` → in-process queue → every message normalised into the store
2. **Provenance on every record** (message ID, sender, group, timestamp) — at ingest, not later
3. **Voice note transcription** ← the differentiator, protect its time
4. Classification + structured extraction, one call, tagged union
5. Mongo persistence + MinIO media + **persisted Baileys auth state** (survives a restart without re-pairing)
6. Conversational onboarding in DM (register, pick courses)
7. **Outbound DMs** — instant announcement alert + daily digest
8. Cited Q&A over the store

### v1 — also in (build after the spine)

9. **Course resource library** — tag documents at ingest, retrieve on request, send the file back
10. **Deadline warning with the file attached** — a join between announcements and resources
11. **Conflict surfacing** — two sources disagree, show both, never guess
12. **Image OCR for photographed timetables** — one image can yield several announcements at once

Items 9–12 depend on the spine. If the spine is not solid, they are worth nothing.

### Explicitly out

Posting in groups · `.ics` files · fee/result/hostel extraction · calendar API · web frontend

**On documents: tag first, then read.** Filename plus the surrounding messages identify the course and type in one LLM call. That tagging is what makes the library work, and it happens whether or not the file can be opened.

Reading the contents is a second, independent pass — added after the original "tag, don't read" scope proved too narrow, because students ask questions whose answers are inside the slides rather than in anything anyone typed in the chat. PDFs are read from their text layer, `.docx` through its XML. A scan with no text layer is read by the vision model instead, and anything read that way is marked, so the answer can say it came from a photograph and may be imperfect.

Because reading is a second pass, it cannot cost anything. A corrupt file, an unsupported format, a scan the model cannot make out — each is still filed, stored and sent on request, and each still gets one searchable record saying Peermate holds the file but cannot read inside it. That record matters: without it, asking about a scanned past-paper returns nothing and Peermate claims never to have heard of a file it is holding.

## 7. Privacy — the central claim

Peermate reads the messages of everyone in a group, including people who never registered with it. For the prototype and public demo, only staged groups and synthetic messages are used:

- **It posts nothing, ever, in any group.** It is a reader. Group members see a number that never speaks.
- **A group is read only after an operator approves it.** Anyone can add the number to any chat, and being added is not consent from the people already in it. A new group is recorded as `pending` and nothing in it is ingested, embedded or extracted until it is approved against a named course. A student who added the bot can say which course a group is for; that is recorded as a proposal and relayed, never acted on. This reverses the original design, where a group became live the moment the number joined it.
- **It reports only to registered students about their selected courses.** Course membership verification is not implemented in the prototype, so it must not be deployed in real student groups yet.
- **Registration is always initiated by the student.** Peermate never DMs someone who has not messaged it first. It will not harvest group participant lists to find users, even though the API permits it.
- **The bot number must be a dedicated account.** A companion device sees everything that account sees — its personal DMs and every unrelated group, not just the course groups. Peermate is linked to a fresh SIM used for nothing else. Never link it to a personal WhatsApp account.
- **OpenAI processes message content.** There is no third-party message broker in the path; the socket is direct. Content leaves the host only for transcription, vision and extraction. Data is not sold or intentionally surfaced outside the staged demo users.
- **A group admin can remove the number at any time**, which ends ingestion for that group immediately.

Production consent, access control, retention and deletion are explicitly deferred. Never use real classmates' messages in this prototype.

## 8. Architecture

```
WhatsApp groups
      │  (multi-device WebSocket — bot number linked as a companion device)
      ▼
  Baileys socket ── one Node process. Persists auth state, listens on messages.upsert,
      │             dedupes by key.id, pushes onto an in-process queue and returns
      │             straight away so a slow transcription never stalls the socket.
      ▼
  ingest worker
      ├─ persist → messages (raw, append-only, full provenance)
      ├─ media?  → downloadMediaMessage → MinIO → Whisper (audio) / vision (image)
      ├─ update  → transcript/OCR result + processing status
      ├─ embed   → Chroma, one document per message
      └─ extract → one LLM call, tagged-union schema
                      ├─ kind=noise/question → stop
                      └─ kind=announcement   → extractions (append-only)
                                                   │
                                             notifier → instant DM to subscribed students
      │
  scheduler ── 07:00 digest per student
      │
  DM handler ── onboarding state machine · Q&A · "CSC 301 resources"
                   └─ retrieval: Chroma metadata filter (course + window), k=20–30,
                      LLM resolves supersession and conflicts from timestamps
```

**Stack.** One Node process, TypeScript. Baileys (`@whiskeysockets/baileys`) for WhatsApp, Express for the small HTTP surface that remains (health, admin), the official `mongodb` driver, `chromadb` for vectors, the `minio` SDK for media, the `openai` SDK for Whisper, vision and extraction, and `node-cron` for the 07:00 jobs. Extraction uses OpenAI structured outputs against a zod schema, so the tagged union below is enforced at the API rather than by parsing a reply.

There is no Node backend in this workspace to copy from — [unidash-api](../unidash-api/) and [unimart-api](../unimart-api/) are Go, [uniwrite-api](../uniwrite-api/) is Python — so what carries over is the layering, not the stack: `src/whatsapp`, `src/services`, `src/repositories`, `src/workers`, `src/db`. The point of that layering was that outbound has exactly one home and storage has exactly one home. That survives the language change, and the split-the-directions escape hatch below depends on it.

**In-process, not a gateway.** Baileys is a library holding a socket, not a service. With the whole spine in Node there is no gateway process, no shared token, no inbound webhook and no HTTP hop between the socket and the worker — the `messages.upsert` handler pushes straight onto the queue.

The tradeoff is that the socket and the worker now share a fate. An unhandled rejection during extraction takes WhatsApp ingestion down with it, so the worker catches per message and never throws into the socket handler. That is the one discipline this design buys its simplicity with.

### Collections

| Collection | Purpose | Key fields |
|---|---|---|
| `groups` | which groups the bot is in | `chat_jid` (`…@g.us`), `name`, `default_course`, `joined_at` |
| `users` | registered students | `phone`, `jid` (`…@s.whatsapp.net`), `name`, `courses[]`, `onboarding_state`, `registered_at` |
| `messages` | every source message | `wa_message_id` (`key.id`), `chat_jid` (`key.remoteJid`), `sender_jid` (`key.participant`), `sender_phone`, `sender_name`, `timestamp`, `type`, `text`, `caption`, `quoted_message_id` (`contextInfo.stanzaId`), `media_key`, `transcript`, `processing_status` |
| `extractions` | every extracted event, **append-only** | `source_message_id`, `kind`, `course`, `event_type`, `original_date_text`, `date`, `time`, `venue`, `confidence`, `extracted_at` |
| `resources` | the course library | `course`, `doc_type`, `filename`, `media_key`, `posted_by`, `posted_at`, `source_message_id` |
| `notifications` | delivery log | `user_phone`, `extraction_id`, `notification_type`, `status`, `sent_at` |

`extractions` are append-only. A venue change creates a new extraction rather than updating history. `messages` may be updated with transcription and processing status as the worker completes.

`wa_message_id` has a unique index so the re-delivery WhatsApp performs when a dropped socket reconnects does not repeat processing or send the same notification twice. Distinct classmates posting the same announcement remain distinct source records. This small idempotency guard stays in because reconnect re-delivery could otherwise break the demo.

### Extraction schema

One call per message. The verdict is the first field, so the model commits before it feels any pressure to fill event fields. The result supports multiple events because one timetable image or voice note can contain several announcements:

```json
{
  "kind": "announcement | question | noise",
  "announcements": [
    {
      "course": "CSC 301",
      "event_type": "test | assignment | lecture | meeting | venue_change | deadline",
      "original_date_text": "Friday",
      "date": "2026-09-18",
      "time": "10:00",
      "venue": "LG7",
      "confidence": 0.0
    }
  ]
}
```

Each stored row also carries `event_id` (the event, not the message — one voice note can carry two deadlines), `authority` (`lecturer | rep | student`), and `corroborated_by` (the source messages that later said the same thing).

`kind` is always required. `announcements` is required and non-empty only when `kind` is `announcement`; on `noise` the response is one field and costs nothing. Null over guessing. Relative dates such as “Friday” are resolved using the message timestamp and `Africa/Lagos`, while retaining `original_date_text` for citation.

**Course resolution.** The extractor is given the group's `default_course` as context and may override it when the message clearly names another course. `Dept Notices` has no default, so the model must name the course or return null.

**Course identity.** The model returns "CSC 301", "CSC301" and "csc 301" for the same course, and students type all three too. Every record carries a canonical `course_key` (`CSC301`) beside the display form, and **every match — subscriptions, retrieval filters, the library — uses the key**. This is not tidiness: an exact match on the display string returns nothing, raises no error, and a student who wrote "csc301" at onboarding silently never hears from Peermate again.

**What the extractor is allowed to read.** Only words somebody actually said: the text, the caption, or the transcript. A filename is not an announcement. Five class-notes PDFs posted with no caption once produced five confident test alerts, one with a venue of `/dev/null`, because the model had been handed nothing but `Unilorin_CVE575_ClassNotes.pdf`. A file with nothing said about it is still filed and still read, but there is no announcement in it to find.

**Message context.** Captions and quoted messages travel with the source message. For phrases such as “No, it is LG8,” the extractor receives the quoted message when available. For documents without a useful filename or caption, it receives up to three preceding text messages from the same group; this bounded window is used only for tagging and its source IDs are recorded.

### Retrieval

Every processable message is embedded into Chroma as **one document per message** — never chunked across messages — carrying `source_message_id`, `course`, `sender`, and `timestamp` in metadata. Citations therefore point at a real message, not a chunk. Stickers and unsupported empty media are retained but not embedded.

On a question: filter by one of the user's selected courses and a recent time window. Retrieve k=20–30 within that slice and hand the LLM the whole candidate set with timestamps. The LLM resolves obvious corrections; when records genuinely disagree, it shows both with their sources and does not choose.

### Outbound

- **Instant DM on every new announcement** to every student subscribed to that course.
- **Daily digest at 07:00 Africa/Lagos**, containing new announcements since the previous digest plus events due that day.
- **Deadline warning at 07:00 on the due date**, with the brief attached when a matching course resource exists.
- **Semantic dedupe, reversing the original decision.** Three classmates mentioning one test is one test, and three identical DMs read as a bug rather than as thoroughness. A repeat is matched on course, event type, date, and any *stated* time and venue — nulls stay open, so "test Friday" and "test Friday 10am in LG7" are one event that gains detail, while two same-day assignments with different deadlines stay two. A matched repeat is recorded as corroboration and fills gaps in the first telling; it never overwrites a stated value, and it does not produce a second DM.
- **Whose word it was decides whether a repeat is worth hearing.** Each group can name trusted senders — a lecturer, a class rep — and every extraction stores the `authority` of whoever said it. A classmate repeating a classmate is backing, and silent. A lecturer confirming what a classmate said changes whether the student can act on it, so that one is sent, as a confirmation rather than as news.
- **Per-user delivery controls, also reversing the original decision.** Being unable to turn Peermate down is what gets it muted at the WhatsApp level, which loses the student everything rather than the part they objected to. A student can pause everything, pause until a day they name, mute one course, narrow to urgent only, or turn off the morning digest alone. Quiet hours (22:00–06:00 by default) hold instant alerts. Nothing is discarded by any of these: the digest covers everything since it last ran, so a hold defers rather than deletes.
- **An alert never lands in the middle of a conversation.** An announcement arriving seconds after a student asked something reads as the answer to their question. While an exchange is live the alert is held, batched with anything else that arrives, and sent once the thread goes quiet — capped, so a long conversation cannot bury a test alert.

Every one of these decisions is enforced in one place, `DeliveryService`. A rule applied in three services is a rule that will be missed in the fourth, and the failure mode — messaging someone who asked to be left alone — is the one students do not give a second chance.

All outbound goes through `NotifierService`, the only module that touches `sock.sendMessage(jid, …)` — text as `{ text }`, files as `{ document, fileName, mimetype }` with the bytes read back from MinIO. Note there is no send-by-URL: Baileys uploads the file to WhatsApp's CDN itself, so the bytes must pass through the process.

Phone-to-JID normalisation follows `formatPhoneAsChatID` in [unimart-api](../unimart-api/internal/services/whatsapp.service.go) with the suffix changed — Nigerian local `0…` becomes `234…@s.whatsapp.net`, **not** `@c.us`. This is the same class of silent failure as `course_key`: a wrong suffix does not error, it just never arrives.

### Other decisions

- **One socket, one bot number.** There is no per-instance billing to economise on any more, so the constraint is operational rather than financial: one linked device, one process, one socket. Two processes against the same auth state corrupt the session and force a re-pair.
- **There is no official migration path.** Meta's WhatsApp [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) caps a group at **8 participants**, covers only groups the business itself creates, and requires an Official Business Account — so it cannot host a 120-person course group. Unofficial access is not a stepping stone to a sanctioned one; at scale the ban risk on the bot number is managed, not escaped.
- **Possible later: split the directions.** Read groups through Baileys, send DMs through Meta's Cloud API on a second number, so a ban costs ingestion rather than every student's conversation. The cost is real — outside a student-opened 24-hour window every proactive DM becomes a paid, pre-approved template, which is most of them under the instant-alert policy. All outbound goes through `NotifierService`, so this stays a one-class change — and [whatsapp-integration](../ai-agenty/whatsapp-integration/), Meta's Jasper's Market sample, is Express too, with a working Cloud API send path to crib from.
- **Sponsors:** OpenAI plus at most one more, used genuinely. Five shallow integrations score worse than one real one.

## 9. Demo setup

Peermate's knowledge of a group starts when it joins, so **messages must arrive during the demo**. Plan it:

- Stage 3 groups: `CSC 301`, `STA 202`, `Dept Notices`. Add the bot number. Teammates post as classmates.
- Record **one real voice note** — someone speaking a test date, venue, and a deadline, in natural accented English. This is your money shot.
- Photograph **one handwritten timetable** for the OCR moment.
- Prepare **4 dummy course PDFs** with realistic filenames (`CSC301_wk3_slides.pdf`, `CSC301_past_questions_2023.pdf`, etc). These get dropped in the groups during the demo and come back as the assembled library.
- **Pair the bot number before the day and do not unlink.** Re-pairing mid-demo costs the session and any synced history, and a QR scan on camera is not the two minutes you want to spend.
- Seed Mongo and MinIO before recording so a cold restart still has history. Test the restart — persisted auth state is the thing being tested, because a restart that demands a fresh QR scan ends the demo.
- **Never use real classmates' messages.** The repo and video are public; publishing other people's chat is not yours to do.

**Video structure — split screen.** Left: groups filling with noise and an unplayed voice note. Right: Peermate's DM turning it into one clean digest. That contrast is the pitch. Spend the two minutes on the voice-note answer and the multi-group digest, not on UI.

## 10. Eligibility

The project must be **net-new, built during the event**. Be ready to say which parts were built on the day.

**Prep beforehand:** repo scaffold, bot number paired via Baileys with auth state persisting across a restart, the Node app reading one test group, staged groups + voice note + timetable photo, document schema on paper.
**Built on the day:** extraction, onboarding, digest, Q&A, storage logic.

## 11. Deliverables — all five or it doesn't count

1. Title
2. Written description
3. **Public GitHub repo**
4. **Two-minute demo video**
5. **Social post tagging sponsors**

No live pitch. Judging is global and video-based, scored 1–5 on four criteria after submissions close.

---

# User flow

## Registration

1. Amina messages the Peermate number: *"hi"*.
2. Peermate asks which courses she takes. She replies *"CSC 301, STA 202"*.
3. She is registered. She immediately has access to everything Peermate has already stored for those courses — past announcements and the file library.

## Primary flow — the announcement she'd have missed

4. Dr. Bello sends a 90-second voice note in `CSC 301`. Forty messages of noise follow. Amina opens none of it.
5. Peermate transcribes it, extracts `CSC 301 test · Friday 10:00 · LG7`, stores it with the source message ID and sender, and DMs her within the minute:
   > **CSC 301 test — Friday 10am, LG7**
   > *Dr. Bello, voice note, Tue 4:12pm*
6. She never scrolled. She never played the voice note.

## Daily digest

7. **07:00.** Everything across her selected courses in one message:
   > 3 things today
   > • CSC 301 test — Friday 10am, LG7 *(Dr. Bello, voice note, Tue 4:12pm)*
   > • STA 202 assignment due tonight 11:59pm
   > • Dept meeting moved to Thursday

## Reactive — cited Q&A

8. She DMs: *"where is the CSC 301 test again?"*
9. Peermate: *LG7, Friday 10am — from Dr. Bello's voice note, Tuesday 4:12pm.*

## Resources

10. She DMs: *"CSC 301 resources"*
11. Peermate replies with the shelf and **sends the files**:
    > CSC 301 — 4 items
    > • Lecture slides wk3 *(Dr. Bello, 22 Aug)*
    > • 2023 past questions *(Chidi, 28 Aug)*
    > • Assignment brief — due Thursday *(Chidi, 28 Aug)*
    > • Course outline *(Dr. Bello, 12 Aug)*

    …followed by the actual PDFs as WhatsApp attachments.

12. **Better, unprompted:** the deadline warning arrives *with the brief already attached.* *"STA 202 assignment due tonight 11:59pm — here's the brief."* She never asked for the file.

## Conflict

13. Two classmates post different dates. Retrieval returns both records and Peermate refuses to choose:
    > Two versions of the STA 202 deadline. Chidi said Friday (Mon 9pm). Dr. Musa said Thursday (Mon 2pm). I can't confirm which is current — please check with Dr. Musa.

## Failure paths

| Failure | Behaviour |
|---|---|
| Duplicate delivery on reconnect | Skip on the unique index; do not reprocess or notify |
| Transcription fails | Keep the audio in MinIO, mark the message unprocessed; digest continues |
| Extraction low confidence | Surface as "possible" with source; never assert |
| Model returns `kind: noise` on a real announcement | Lost silently — the known cost of one-call extraction. Spot-check against the demo set. |
| Unsupported or oversized media | Retain source metadata, skip embedding, and explain the limitation if a student requests it |
| Outbound send fails | Log the failure; retry once without creating a duplicate notification |
| No announcements today | Say so plainly; don't invent a digest |
| Socket drops | Baileys reconnects on its own, and WhatsApp usually re-delivers what was missed — usually, so do not lean on it during the demo. The unique index makes the re-delivery harmless. |
| Logged out (`DisconnectReason.loggedOut`) | Auth state is dead and no reconnect will fix it; retrying loops forever. Stop, alert, re-pair by hand. |
| Unhandled error mid-ingest | Caught per message and logged. It must never propagate into the `messages.upsert` handler, which would take ingestion down with it |
| Session drops mid-demo | Prerecorded backup video |
| Store empty on restart | Seeded Mongo + MinIO prevents this — test a cold restart before recording |
