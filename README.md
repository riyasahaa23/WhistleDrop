# WhistleDrop

WhistleDrop is a privacy-first confidential reporting backend. Reporters submit a category, description, and optional evidence URL without an account. They receive a high-entropy case code, which is the only credential required to track the report.

## Quick start

Requirements: Node.js 20+ and npm 10+.

```bash
cp .env.example .env
npm install
npm run dev
```

The API starts at `http://localhost:3000`. SQLite data is stored at `./data/whistledrop.db`.

For production, set a unique `MODERATOR_JWT_SECRET` and strong moderator credentials. Never commit `.env` or the database.

## Architecture

See [docs/architecture/backend.md](docs/architecture/backend.md). The monorepo follows the reference layout with a root workspace and `apps/api`.

## API

### Submit an anonymous report

`POST /api/v1/reports`

```json
{
  "category": "HARASSMENT",
  "description": "A detailed confidential report with enough context to investigate.",
  "evidenceUrl": "https://example.com/reference"
}
```

Response `201`:

```json
{
  "message": "Report submitted successfully.",
  "caseCode": "7KQ...26 uppercase characters...",
  "report": { "status": "SUBMITTED", "createdAt": "2026-10-03T10:00:00.000Z" }
}
```

Save the case code. It cannot be recovered if lost.

### Track a report

`GET /api/v1/reports/:caseCode`

Returns category, current status, timestamps, and moderator updates. It deliberately excludes the description, evidence URL, internal database id, and any reporter identity.

### Moderator login

`POST /api/v1/moderator/login`

```json
{ "email": "moderator@example.com", "password": "change-me-in-development" }
```

Returns a one-hour JWT. Use it as `Authorization: Bearer <accessToken>`.

### Moderator report management

- `GET /api/v1/moderator/reports?category=SECURITY&status=SUBMITTED&limit=25&offset=0` — list/filter reports.
- `PATCH /api/v1/moderator/reports/:id` — update status and append a reporter-visible update.

```json
{ "status": "UNDER_REVIEW", "update": "Your report has been assigned for review." }
```

Status transitions are `SUBMITTED → UNDER_REVIEW → RESOLVED | DISMISSED`. Terminal statuses cannot be changed.

### Health

`GET /health` returns `{ "status": "ok" }`.

Invalid input returns `400`; unknown case codes return `404`; missing/invalid moderator credentials return `401`; invalid status transitions return `409`.

## Privacy and security decisions

- No reporter account, email, name, IP, user-agent, or session is collected by the application.
- The case code is 26 characters from an ambiguity-reduced alphabet and is generated from cryptographic random bytes. Only its SHA-256 hash is stored.
- Tracking responses do not expose report descriptions or evidence URLs, reducing accidental disclosure if a case code is shared.
- Moderator functionality is protected by JWT authentication and rate-limited. Helmet adds standard security headers.
- SQLite uses WAL mode and foreign keys; the database path is configurable.
- This service cannot prevent infrastructure-level access logging or traffic analysis. Deploy behind HTTPS, configure reverse-proxy log minimization, restrict database access, rotate secrets, and add operational audit logging before handling highly sensitive production reports.

## Verification

```bash
npm test
npm run typecheck
npm run build
```
