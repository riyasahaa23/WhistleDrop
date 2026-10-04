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

For production, set a unique long `MODERATOR_TOKEN`. Never commit `.env` or the database.

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

`GET /api/v1/reports/:caseCode` (or privacy-preferred `POST /api/v1/reports/track` with `{ "caseCode": "..." }`)

Returns category, current status, timestamps, and moderator updates. It deliberately excludes the description, evidence URL, internal database id, and any reporter identity.

### Evidence upload

`POST /api/v1/reports/:caseCode/evidence` accepts one PDF, PNG, JPEG, or UTF-8 text file up to 5 MiB as `multipart/form-data`. Files are validated by MIME type and signature, scanned through ClamAV's `INSTREAM` protocol, and stored under a random filename with restrictive permissions only after a clean scan. If ClamAV is unavailable, uploads fail with `503`; malware is rejected with `422`. Files are never included in public tracking responses. Closed cases reject uploads. Moderator downloads require authentication.

### Moderator access

Set `MODERATOR_TOKEN` to a long random secret. Send it directly with every moderator request:

```http
Authorization: Bearer <MODERATOR_TOKEN>
```

### Moderator report management

- `GET /api/v1/moderator/reports?category=SECURITY&status=SUBMITTED&search=keyword&createdAfter=2026-01-01T00:00:00.000Z&createdBefore=2026-12-31T23:59:59.000Z&limit=25&offset=0` — list/filter reports. Search applies to report descriptions; the plaintext case code is never stored.
- `PATCH /api/v1/moderator/reports/:id` — update status and append a reporter-visible update.
- `POST /api/v1/moderator/reports/:id/updates` — append a reporter-visible update without changing status.
- `POST /api/v1/reports/:caseCode/evidence` — upload validated evidence using the case code.
- `GET /api/v1/moderator/reports/:id/evidence/:evidenceId` — download evidence for an authenticated moderator.

```json
{ "status": "UNDER_REVIEW", "update": "Your report has been assigned for review." }
```

```json
{ "update": "The review team has requested additional internal checks." }
```

Status transitions are `SUBMITTED → UNDER_REVIEW → RESOLVED | DISMISSED`. Terminal statuses cannot be changed.

### Health

`GET /health` returns `{ "status": "ok" }`.

### Swagger documentation

Open `http://localhost:3000/docs` while the server is running. The raw OpenAPI document is available at `GET /docs/json`.

Screenshots of the running API and Swagger UI are available in [`screenshots/`](./screenshots/):

- [Swagger API overview](./screenshots/swagger-backend.png)
- [Anonymous report submission](./screenshots/anonymous-submission.png)
- [Anonymous report tracking](./screenshots/anonymous-tracking.png)
- [Health check](./screenshots/health.png)
- [README/API evidence](./screenshots/readme.png)

### Permanent case closure

`POST /api/v1/moderator/reports/:id/close` permanently closes a case for moderator retention workflows. A closed case cannot receive further status changes. Closure records only the moderator action and timestamp in an audit table; it does not record reporter identity.

Invalid input returns `400`; unknown case codes return `404`; missing/invalid moderator credentials return `401`; invalid status transitions return `409`.

## Privacy and security decisions

- No reporter account, email, name, IP, user-agent, or session is collected by the application.
- API request logging is disabled, public report responses are marked `Cache-Control: no-store`, and the body-based tracking endpoint avoids putting the case code in a request URL.
- The case code is 26 characters from an ambiguity-reduced alphabet and is generated from cryptographic random bytes. Only its SHA-256 hash is stored.
- Tracking responses do not expose report descriptions or evidence URLs, reducing accidental disclosure if a case code is shared.
- Moderator functionality is protected by a constant-time-checked bearer token and rate-limited. Helmet adds standard security headers.
- SQLite uses WAL mode and foreign keys; the database path is configurable.
- Evidence is stored outside SQLite under randomized names, with restrictive file permissions and no original filename retained. Upload limits and storage directory are configurable.
- This service cannot prevent infrastructure-level access logging or traffic analysis. Deploy behind HTTPS, configure reverse-proxy log minimization, restrict database access, rotate secrets, and add operational audit logging before handling highly sensitive production reports.

## Verification

```bash
npm test
npm run typecheck
npm run build
```
