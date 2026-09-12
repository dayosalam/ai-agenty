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
| **Converse** | Holds a short memory of the last exchange, so the follow-ups people actually send — *"where is it?"*, *"who said that?"*, *"send the second one"* — resolve against what was just discussed rather than starting cold. Keeps the running thread for longer, so *"you said Thursday"* has something to refer to. |
| **Prepare** | Builds a practice set for a course out of the files people shared — what the material covers, then questions in the style the lecturer sets — and quizzes the student one question at a time, marking each answer. |

**A DM can be spoken or photographed, not just typed.** Media is read before the DM and group paths diverge, so a recorded question is transcribed and a photographed timetable is OCR'd exactly as it would be in a group. A student can register by sending a picture of their timetable and ask questions without typing.

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
| `conversations` | the thread, per student | `phone`, `course_key`, `event_id`, `source_message_id`, `files[]`, `last_answer`, `turns[]`, `quiz`, `pending_action`, `updated_at` (30d TTL) |
| `schedules` | a student's own timetable, **private to them** | `phone`, `course_key`, `kind`, `date` *or* `weekday`, `time`, `venue`, `source_message_id` |
| `courses` | what a code means | `course_key`, `code`, `title`, `lecturer`, `aliases[]` |

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

### Conversation

Follow-ups are the normal case, not the exception. Nobody asks "where is the CSC 301
test on Friday?" twice; the second question is "where is it?". A per-student record
holds the last course, event, source message, answer and file list, expiring after 45
minutes — long enough to resolve a pronoun, short enough that a stale referent never
produces a confident answer about the wrong event.

- **An alert seeds the memory.** Every instant DM records its event against that
  student, so the question that follows it has an antecedent. Without this the obvious
  next message is answered against the whole course.
- **Retrieval is not the only path.** "Repeat that" returns the stored answer verbatim
  rather than searching again — a second search can return something different, which
  is the one thing repeating must not do. "Send the original" returns the actual voice
  note or photo the claim came from.
- **Answers about Peermate never go to retrieval.** "How do I approve it?" and "what
  group have you been approved for?" are about Peermate, not about a course; searching
  the archive for them reports hearing nothing, which reads as broken. These are
  answered from live state — the group actually waiting, the course somebody proposed
  for it, the courses no group covers — before any model call.
- **Anything Peermate asked, Peermate answers itself.** A bare "CVE 575" straight after
  "which course?" is an answer, not a question, and leaving that to the router makes it
  a coin flip. Pending questions are recorded and matched literally. Every one of them
  can be abandoned by changing the subject.
- **A group's course is confirmed before it is relayed.** What gets agreed decides
  where a semester of announcements is filed, and the student cannot see what their
  typed — or photographed — course code became. A different code offered at the
  confirmation is read as a correction, not a refusal.
- **A spoken message that cannot be understood is transcribed back.** Otherwise a voice
  note is a black box: the student cannot tell a misunderstood request from a misheard
  word, and on a short recording it is almost always the latter.

### Remembering the conversation

Two different memories, governed by different rules, because they fail differently.

**Referents expire.** The last course, event, source message, answer and file list are
held for 45 minutes. A stale "it" is worse than no "it": it produces a confident answer
about the wrong event, and the student has no way to tell.

**The thread does not.** The last twenty exchanges are kept verbatim, both sides, and
survive that expiry. A transcript cannot be wrong in the way a referent can — it is
only ever a record of what was said. Without it, "you said Thursday", "the one you
mentioned earlier" and "what did I ask you yesterday?" are unanswerable, and every
message starts from nothing.

- **Every reply is in it, not just the ones a model wrote.** A file listing, a command
  reply and a pushed alert are all things Peermate said. "You told me it moved" refers
  to an alert nobody asked for.
- **Each line is stamped.** The model can see that an exchange was three days ago and
  weigh it accordingly, instead of treating it as something just said.
- **It is history, never a source.** The router and the answerer both get the thread,
  with an explicit rule: use it to understand what is being referred to, never to
  support a claim about a course. An answer whose only backing is Peermate's own
  earlier reply is a citation of itself.
- **Turns are clipped and capped.** 500 characters each, forty of them, oldest dropped
  first. A digest runs to hundreds of words and would otherwise crowd out the question.

### Preparing for a test

The files are already read, chunked by page and indexed — that is how questions about
them get answered. The same material answers a bigger question: *am I ready?*

- **Material, not memory.** Questions are built from the chunks of the actual files
  for that course, fetched by metadata rather than by similarity — revising means
  covering the material, and a search for "what is on the test" returns only the corner
  of it that phrases itself that way. A model asked to prepare somebody for "CVE 575"
  with no files writes a plausible syllabus out of its own memory and prepares them
  confidently for an exam nobody is setting.
- **No files, no practice set.** A course with nothing shared is told so, and asked for
  the files. Files Peermate holds but could not read are named, and offered.
- **Past papers lead.** They are what the test actually looks like, so they are sampled
  first. The rest of the sample is spread across files rather than taken in order — the
  first forty chunks of a slide deck are its introduction.
- **The answer is always shown.** Right, close or wrong, the correct answer and its
  page follow. Being told only "wrong" teaches nothing, and a student revising alone
  has nowhere else to look.
- **The set is built once and kept.** The same material asked twice produces different
  questions, so a quiz rebuilt each turn would be a different quiz each turn and the
  running score would mean nothing.

### Replying to a specific alert

WhatsApp's Reply quotes a message by id. A student scrolling back to Tuesday's alert
and replying to it means *that* one — which is precisely the case the 45-minute
context cannot cover, because the whole point of using Reply is that it is not the
current subject.

Each delivered alert is recorded against the student with the id WhatsApp gave it, so
a quoted reply resolves to the event it was about. Fifty are kept — far enough back to
cover any message still worth replying to. A quoted reply is treated as a follow-up
whatever the router makes of the words, because the student pointed at the message.

One outbound message carrying several batched alerts can only point at one event, so a
reply to it resolves to the most recent — the one at the bottom of what they just read.

### Two requests in one message

People ask for two things at once. Only one intent can be acted on, so the second is
routed and acted on in its own right — one extra round, never a third. When that
routing is not confident, or the course is ambiguous, the reply says plainly what went
unanswered instead of guessing at it. Admitting the gap is the fallback, not the plan.

### Exa — widening the explanation, never the syllabus

Exa is given the topics the course files raised, and nothing else.

**Material from outside the group is offered, never substituted.** Peermate was added
to one group and told to listen there; answering "have you got the notes?" with
something off the internet — unasked, unlabelled, and not what their lecturer set — is
a different product from the one the student agreed to. So a course with no files, or
an outright request for external material, gets a question first. Only on a yes does it
search, and what comes back is a numbered list to pick from rather than files that
simply arrive.

**A code written in a filename is evidence, not a judgement call.** The tagging model
returned no course for `CVE 565.pdf` in the same batch where it filed
`Unilorin_CVE575_Course 1-3.pdf` correctly, and a file with no course is invisible to
every question about that course — the student is told nothing was ever shared while
Peermate is holding it. A single unambiguous code in the filename now decides, with the
model left to settle genuinely ambiguous names. Sequence numbers and years are not
course numbers: `scan001.pdf` and `Assignment 2023` both parse as codes and both are
rejected.

**A course code is not a subject.** "CVE 575" is a local invention: it means nothing
outside the university that issued it, and a web search on it matches MATH 575 just as
happily — which is what a student asking for transportation engineering material got.
So the search is built from the course *title* and the student's own words, with the
code dropped entirely once a title is known, and every result is checked for at least
one word of the subject before it is offered. A Math 575 review sheet offered for a
transportation course is not a near miss; it is the wrong subject, and the student
cannot tell before they open it.

When no title is on record, the request itself supplies one — "material for CVE 575
transportation engineering" is often the only place that name has ever appeared. A
title that came from a document is never overwritten by one taken from a message.

**Nothing new means the list again, not a dead end.** The message carrying a set of
results can be lost to a dropped socket, and asking a second time is exactly what
somebody does when that happens — so a second search that turns up nothing new shows
what it already found rather than reporting failure over results Peermate is holding.

**"Can you get one more" is not a fresh decision.** They already consented, so it
searches again straight away, excluding what it has already offered.

A URL ending in `.pdf` is a claim: what comes back is as often a login wall or an error
page. The bytes have to begin with `%PDF-` and fit under the size cap before anything
is sent, and a file that fails is **named** rather than counted, because the link is
still in the list for the student to open themselves. Nothing fetched is stored — it
belongs to whoever published it, and keeping copies would quietly turn Peermate into a
library of other people's documents.

It never sees the student's question, never contributes a quiz question, and never
supplies a fact Peermate repeats as its own. What comes back is a link, printed under
*Going deeper (from the web, not from your files)*, for the student to decide about.

That boundary is the whole design. A student revising has to know which lines came from
their lecturer's notes and which came from a stranger's blog, because only one of those
is what they will be tested on. Searches are framed by the course — "modulus" alone
returns finance, not engineering — and a failed or slow search removes the section
rather than the prep. With no `EXA_API_KEY`, the feature is simply absent.

### The student's own timetable

A student photographs their exam timetable and sends it in a DM. That is a different
thing from a lecturer posting one in a group, and it is stored separately.

**A DM upload is private to the student who sent it.** It may list courses nobody else
takes, it may be a draft, and its dates come from OCR of somebody's handwriting.
Treating it as an announcement would make one student's misread photograph into the
whole class's exam date — so it lands in `schedules`, keyed to them, and never reaches
another student. A timetable posted in a *group* still goes the announcement route,
because somebody said it to everybody.

**The picture is classified before anything is read out of it** — course list, exam
timetable, class timetable, or none of those — for the same reason extraction commits
to `kind` first. A blurred or cropped photo is marked unreadable and produces nothing,
rather than a confident schedule assembled from guesses.

**Weekly items store a weekday, dated items store a date.** A lecture recurring every
Tuesday is one row, not fifteen. Dates are chosen from an offered calendar exactly as
in extraction; anything outside it is dropped to null rather than becoming a reminder
that fires on a day nobody named.

**Nothing is stored until the student confirms it.** They cannot see what the OCR made
of their handwriting, and a silently accepted misreading surfaces weeks later as a
reminder for the wrong day.

**"Next" means next, not next dated.** A weekly class carries a weekday and no date,
so counting only dated rows answers "nothing on your timetable" to somebody with a
lecture in the morning. The next occurrence of a weekly row is as real as a date
written on an exam sheet, and what a group announced is weighed alongside both.

**A question about "my" timetable is about all of it.** Only a course the student names
in that message narrows it. A course carried over from the previous exchange turns
"when is my next class?" into an answer about one course, which reads as Peermate
having forgotten the rest of their timetable.

**The entries decide, not the label.** A week's grid is mostly course codes, so the
classifier calling it a course list is the easy misread — and acting on that label
discarded a fully read timetable, leaving the student enrolled in the right courses
with no schedule and nothing to say anything had been lost. A read that produced rows
is a timetable; only one that produced none is a course list.

**Registration is when a timetable is most likely to arrive.** Onboarding reads the
course codes off the photo and stops there, so the grid was discarded at exactly that
moment and "when is my next class?" then answered that it had never seen one. The read
is held instead, and offered once registration is finished — not straight away, because
onboarding still has its own questions to ask and two open questions collide.

**A photographed timetable enrols the courses on it.** It is the most authoritative
statement of what a student takes, and storing keeps only rows for courses they watch —
so without this a first timetable is read correctly, previewed in full, and then stores
nothing.

### Reminders

Announcements tell a student something exists. Reminders are what stop them missing
it anyway.

Two sources, one path: events extracted from group announcements, and the student's
own uploaded timetable. Both are filtered through the same delivery gate as everything
else, so a pause or quiet hours holds a reminder exactly as it holds an alert.

Lead times differ by what is being missed — an exam is worth a day's warning, a
lecture is worth an hour's — and every reminder is recorded so a restart, a second
scheduler pass or a manual run cannot send it twice.

### Knowing which course they mean

Students do not say "CVE 575". They say "structural analysis", or "Dr Bello's course".
Course matching is on `courseKey` everywhere, and a near-miss returns nothing and
raises nothing, so without somewhere to put titles and lecturers those questions fail
silently rather than visibly.

`courses` holds the code, title, lecturer and any aliases, assembled from whatever
arrives — titles from a photographed timetable, lecturers from a group's trusted
senders. Resolution only ever returns a course the student actually takes, and a title
match must share a *phrase* rather than a single word: "analysis" appears in three
course titles, "structural analysis" in one. Two courses matching equally well is a
real ambiguity, and Peermate asks rather than picking.

Asked about a course, it answers with coverage rather than trivia: whether it is even
reading a group for it, the weekly pattern, what is coming up, and how much it holds.

### Departmental groups

A group that serves a whole department rather than one course. It is set up by
approving it with no course — the extractor then works the course out per message,
and asks when it cannot.

Such a group carries two kinds of message, and they are not the same kind of fact:

- **About one course.** "CVE 575 test moved to LG8" is filed and delivered exactly as
  it would be from a course group — only CVE 575 students hear it.
- **About everybody.** "No lectures on Friday", "resumption is Monday", "the fees
  deadline is the 15th". These have no course to file under, which is
  *indistinguishable from a course that could not be worked out* unless the extractor
  says which it meant. So every announcement carries a `scope`, decided at extraction
  time. A department notice is delivered rather than held for triage, and labelled as
  department-wide so it does not read as a course announcement with its course
  missing.

**Who a department notice reaches.** A student record carries no department, so the
group's own history stands in: whoever takes a course that group has actually carried.
It is an approximation, and a deliberate one — the alternative is broadcasting to every
student Peermate knows, which would send a civil engineering notice to the biology
cohort. Before the group has carried anything there is nothing to narrow by, and it
goes to everyone registered.

Department notices are never deduped or superseded against course announcements: two
unrelated notices are not one event told twice.

**A group approved with no course is still being read.** Every "am I covered?" answer
counts course-keyed groups, and a departmental group has no course to key it by — so
the same minute Peermate said it had started listening, it also said it was reading no
group at all. Coverage now counts open groups as what they are: listening, with the
course worked out per message. Which courses they will end up covering is not knowable
in advance, so it is described rather than promised.

### Sending files

**A course they did not register still gets answered**, when the files exist. Cohorts
here overlap almost completely, and refusing a classmate's past questions on a
registration technicality helps nobody. The reply says plainly that they are not
registered for it.

**Files are offered, not pushed.** Earlier the shelf sent everything up to a limit
automatically, which on metered data spends a student's money on attachments they did
not ask for. The list comes first and the files follow a yes.

### Other decisions

- **One socket, one bot number.** There is no per-instance billing to economise on any more, so the constraint is operational rather than financial: one linked device, one process, one socket. Two processes against the same auth state corrupt the session and force a re-pair.
- **There is no official migration path.** Meta's WhatsApp [Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups) caps a group at **8 participants**, covers only groups the business itself creates, and requires an Official Business Account — so it cannot host a 120-person course group. Unofficial access is not a stepping stone to a sanctioned one; at scale the ban risk on the bot number is managed, not escaped.
- **Possible later: split the directions.** Read groups through Baileys, send DMs through Meta's Cloud API on a second number, so a ban costs ingestion rather than every student's conversation. The cost is real — outside a student-opened 24-hour window every proactive DM becomes a paid, pre-approved template, which is most of them under the instant-alert policy. All outbound goes through `NotifierService`, so this stays a one-class change — `CloudApiService` keeps that send path wired and unused; it was ported from Meta's Jasper's Market sample, which has since been removed from this repo.
- **One person, one address.** WhatsApp reaches a single handset two ways — by phone number and by LID — and Signal keeps a *separate ratchet per address*. Alternating between them desynchronises both, and the handset then shows "Waiting for this message. This may take a while." on everything Peermate sends; the plaintext is unrecoverable. So a person is addressed by the identity their own messages arrive on, resolved in one place (`operatorJid`). `ADMIN_PHONE` may list several spellings of the same operator — that decides who *may* command Peermate — but only one of them is ever written to.
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
