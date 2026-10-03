# WhistleDrop backend architecture

```text
                    ┌──────────────────────────────┐
                    │ Anonymous reporter            │
                    │ (no account, no PII collected)│
                    └──────────────┬───────────────┘
                                   │ HTTPS JSON
                                   ▼
┌────────────────────────────────────────────────────────────────┐
│ Fastify API                                                     │
│ helmet · CORS · rate limiting · Zod validation · error handler  │
├──────────────────────┬───────────────────────┬─────────────────┤
│ Public report routes  │ Public tracking route │ Moderator routes │
│ POST /reports         │ GET /reports/:code    │ JWT + RBAC       │
└──────────┬───────────┴───────────┬───────────┴────────┬────────┘
           ▼                       ▼                    ▼
    Report service          SHA-256 case lookup    Moderator service
           └──────────────────────┬─────────────────────┘
                                  ▼
                       Repository boundary
                                  ▼
                    SQLite (reports + updates)
```

The reference repository's workspace convention is retained: root scripts, `apps/*`, and `docs/architecture`. The API intentionally does not store reporter identity, IP addresses, user agents, or authentication records for reporters. Case codes are generated with cryptographic randomness and only their SHA-256 hashes are stored.

The current persistence adapter is SQLite to keep local setup simple. The repository functions are the swap boundary for PostgreSQL or another managed database. The moderator API returns an internal report id only to authenticated moderators; public tracking never exposes it, the description, or an evidence URL.
