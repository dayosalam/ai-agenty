# Peermate

An agent that lives in university WhatsApp class group chats, hears the announcements
students missed — including voice notes and photographed timetables — and DMs each
registered student privately with what matters, citing where it came from.

It posts nothing in any group. See [PRD.md](PRD.md) for the full specification and
[CLAUDE.md](CLAUDE.md) for the invariants.

## Requirements

- Node 20+
- MongoDB, MinIO, Chroma (see below)
- An OpenAI API key
- A WhatsApp number used for nothing else — pairing grants this process everything
  that account can see

## Setup

```bash
npm install
cp .env.example .env      # then set OPENAI_API_KEY
```

### Infrastructure

With Docker:

```bash
npm run infra:up          # mongo :27017, minio :9000, chroma :8000
```

Without Docker — run the daemons directly. This machine has no Docker, so this is the
path that is actually tested here:

```bash
mongod --dbpath .local/mongo --port 27017 --logpath .local/logs/mongod.log --fork

MINIO_ROOT_USER=peermate-local MINIO_ROOT_PASSWORD=peermate-local-dev \
  minio server .local/minio --address :9000 --console-address :9090 &

chroma run --path .local/chroma --port 8000 &
```

The Chroma client major must match the server: a v1-era client gets HTTP 410 from a
modern server. This repo pins `chromadb` v3 against a Chroma 1.4+ server.

### Run

```bash
npm run dev
```

On first run a QR appears in the terminal. Scan it from the bot number under
**WhatsApp → Linked devices**. Credentials are written to `auth_state/` and reused,
so a restart does not re-prompt.

`auth_state/` is a live session credential. It is gitignored — never commit it, and
never run two processes against the same directory.

## Verify

```bash
curl localhost:3000/health
curl localhost:3000/admin/queue
npm test
```

## Layout

See the project structure and invariants in [CLAUDE.md](CLAUDE.md).
`legacy-python/` is the superseded Python prototype, kept for reference only.
