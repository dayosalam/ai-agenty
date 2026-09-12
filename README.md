# Peermate

Peermate is a personal AI agent that lives in university course group chats and privately helps students keep up with what matters. It listens silently across multiple WhatsApp groups, understands text messages, voice notes, photographed timetables, PDFs and Word documents, and extracts important information such as tests, deadlines, venue changes and class schedules.

Students receive timely alerts and personalized daily digests with citations showing who shared each announcement and when. They can ask follow-up questions, retrieve course files, manage their courses and notification preferences, upload personal timetables, receive reminders, and generate revision guides or quizzes from materials shared in their groups. Peermate also uses Exa to find clearly labelled external reading and additional study materials without mixing web content with official group-chat information.

By turning noisy, fragmented group conversations into one reliable private assistant, Peermate helps students avoid missed announcements, find buried resources and prepare more effectively without constantly scrolling through every class group. Tunes

## Running it

Everything in containers:

```bash
cp .env.example .env      # OPENAI_API_KEY and ADMIN_PHONE are the two that matter
docker compose up --build
```

The first boot has to be paired. Set `WHATSAPP_PAIRING_NUMBER` to the bot's number
(digits only, country code, no `+`) and read the code out of the logs:

```bash
docker compose logs -f app      # INFO: pairing code: ABCD-EFGH
```

Then on the bot's phone: **WhatsApp → Linked devices → Link with phone number**, and
type the code. It pairs once and stays paired.

To develop against the host instead, run the stores in Docker and the app outside it,
which puts the pairing code — or the QR — in your own terminal:

```bash
docker compose up mongo minio chroma
npm run dev
```

## Deploying it

[docker-compose.deploy.yml](docker-compose.deploy.yml) runs the app with MinIO and
Chroma beside it and expects Mongo to be hosted — set `MONGODB_URL` to your cluster and
keep `MONGODB_DATABASE=peermate`, which stays a separate database even on a cluster
shared with something else.

```bash
scp .env you@server:/srv/peermate/.env
docker compose -f docker-compose.deploy.yml up -d --build
docker compose -f docker-compose.deploy.yml logs -f app
```

Read the pairing code out of those logs and link it from the bot's phone. Only port
3000 is published — MinIO and Chroma are reachable only from inside the compose
network, which is where they belong: neither needs to be on the public internet, and an
object store that is costs more than it gives.

Chroma has to be run, not borrowed. The JS client speaks HTTP only — there is no
embedded mode as in Python — so a server is required.

### Two things that break it

**The session lives in a volume, not the image.** `auth_state/` is a live WhatsApp
credential: it is gitignored, excluded from the build context, and mounted at
`/app/auth_state`. Lose the volume and you re-pair by hand from the phone — there is
no token that substitutes for a linked device.

**One process, always.** Two running against one session desynchronise the Signal
ratchet, and every student sees *"Waiting for this message"* with no way back. That
rules out rolling deploys: use `stop-first` (Compose), `Recreate` (Kubernetes) or
`--strategy immediate` (Fly), and never scale past one replica.

