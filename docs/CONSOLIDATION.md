# Consolidation Plan: feat/backend-core + Keren's data layer (Option B)

Status: **phase 1 complete, ready for user validation**. Decisions below are recorded here so they
survive branch changes; code follows in phases 2-4 (one commit per verified phase).

## D1 — Supersede the legacy Python backend

- `backend/app/` (Python/FastAPI/Celery, master) is archived as `backend/_python_backup/`.
- It is not deleted destructively; it stays available for reference and for `scripts/retrain_cycle.py`
  during the transition.
- The canonical backend is **TypeScript (Fastify 5 + Prisma 7)** with the ML inference service
  remaining isolated in Python (`ml/`).

## D2 — Unique TS stack decisions

Final stack (`backend/package.json` after phase 2):

- **Node ≥ 20**, **Fastify 5.12.x**, **Prisma 7.x**, `@prisma/adapter-pg` (pg 8.23.x), **Zod 4.x**
- Types: `@fastify/jwt` 10.x, `bcryptjs` 3.x, `dotenv` 18.x, `tsx` 4.23.x
- Tests: Vitest 5.x + `@testcontainers/postgresql` for an ephemeral, real PostgreSQL
- Prisma generator: `output = "../src/generated/prisma"`, `moduleFormat = "esm"`,
  `importFileExtension = "js"`, client import `../generated/prisma/client.js`
- `PrismaClient` constructed via `createPrismaClient(connectionString)` factory that builds
  `PrismaPg` adapter; process singleton kept for the server; tests/scripts construct their own.

## D3 — Role vocabulary (Spanish, canonical)

The database and the API use Spanish role names so the schema stays aligned with the university
documentation and the Python-side scripts (`scripts/retrain_cycle.py`, `ml/service/schemas.py`):

| Legacy (ours) | Canonical (master/Keren) | Used by |
|---|---|---|
| `OPHTHALMOLOGIST` | `OFTALMOLOGO` | clinical create/validate |
| `RESEARCHER` | `INVESTIGADOR` | gold-standard export / ETL |
| `ADMIN` | `ADMIN` | admin |

This touches `Zod roleEnum` (schemas), `middleware/auth.ts`, `authorize([...])` call sites and
seed/users. Intentional vocabulary break; the seed must be migrated accordingly and the RBAC
smoke tests updated in phase 2.

## D4 — ML class semantic (canonical order)

From `ml/models/manifest.json -> class_names` and Keren's schema comments:

- `0` = `Glaucoma`
- `1` = `Non_Glaucoma`
- `2` = `Suspicious_Glaucoma`

**Our previous worker mapping** (`normal→0, suspect→1, glaucoma→2`) conflicts with the
manifest order and will be corrected in phase 2 in `inference.worker.ts`. Any pre-existing
rows written with the old mapping must be recomputed or discarded (DB stores
`predicted_class` as int; corrections happen at the worker mapping level only).

## D5 — Retain from our side

- Bearer auth and ML bearer token (no literal `Authorization: Bearer` on ML calls — fixed in
  `58c40af` "feat: secure ML service contract").
- Per-profile CORS (`production` deny-all when `CORS_ORIGIN` unset; development allow-all).
- `force: false` removed in `sanitizeImage` (always output JPEG).
- `ioredis` instance for BullMQ (with `maxRetriesPerRequest: null`).
- JWT tests (auth smoke + expiry), RBAC smoke tests (10), and the E2E runbook.
- Cross-cutting integration fixes from commits `ebde419`, `a044d08`, `d77d7f2`, `544495c`,
  `f9a36ca`, `a68a726`.

## D6 — Per-phase commits

Per the user's policy (one commit per phase, verified by the user before the next phase):

- Phase 1 (this doc): decisions only.
- Phase 2: code from Keren (migrations, repositories, feedback/export, ETL, stack, tests).
- Phase 3: Docker + compose alineation.
- Phase 4: validation (build + tests + docker build + E2E).
- Phase 5: PR squash/merge of `feat/backend-core` against `master` (Keren decides with the
  user before PR creation; no direct writes to master).
