# Clearsight backend (Fastify + Prisma)

Capa de datos y endpoints de feedback/ETL del backend. Convive con `backend/app/`
(Python/FastAPI, aún con placeholders) hasta que se retire.

```
src/
  app.ts · server.ts          Fastify + arranque
  config/env.ts               validación Zod del entorno
  lib/prisma.ts               PrismaClient (adapter pg, Prisma 7)
  schemas/                    contrato Zod (common, clinical, patient, consultation, image, inference, feedback, auth)
  repositories/               CRUD Prisma: user, patient, consultation, image, inference, feedback
  services/gold-standard-export.ts   export anonimizado JSON/CSV (lo usan la ruta y el ETL)
  middleware/                 auth (JWT HS256) y rbac — mínimos, reemplazables por los del módulo de auth
  routes/feedback.ts          POST /feedback · GET /export/gold-standard
prisma/                       schema.prisma · migrations/ · seed.ts
scripts/etl-feedback.ts       ETL feedback validado -> dataset de reentrenamiento
tests/                        Vitest + Postgres efímero
```

## Puesta en marcha

```bash
cd backend
npm install
cp .env.example .env                 # DATABASE_URL, JWT_SECRET, EXPORT_HMAC_SECRET
npx prisma generate                  # genera src/generated (gitignored)
npx prisma migrate deploy            # aplica prisma/migrations
npx prisma db seed                   # datos sintéticos (nunca en production)
npm run dev
```

## Migraciones

- `0_init` es `docker/init.sql` **tal cual** (idempotente: `IF NOT EXISTS`). Por eso `migrate deploy`
  funciona igual en una BD vacía y en una ya inicializada por docker-compose; no hace falta `migrate resolve`.
- `20261027000000_prisma_alignment` aplica los cambios sobre el baseline (también re-ejecutable):
  - tabla `users` (+ enum `user_role`); FKs `consultations.doctor_id` y `clinical_feedback.doctor_id` → `users`
    (los `doctor_id` huérfanos se convierten en usuarios placeholder desactivados);
  - `consultations.status` con el vocabulario único de `ml/service/schemas.py` (`PENDIENTE→QUEUED`,
    `EN_PROCESO→QUEUED`, `COMPLETADA→COMPLETED`, `FALLIDA→FAILED`) + CHECK;
  - `inferences`: `job_id` (único), `cdr`, `cdr_vertical`, `quality`, `artifacts`, `elapsed_seconds`;
  - `clinical_feedback`: `validated_class` admite NULL (no concluyente), `updated_at`,
    único `(inference_id, doctor_id)` (los duplicados previos se reducen al más reciente) y
    CHECK «un NULL nunca es gold standard».
- Cambios futuros: editar `schema.prisma` y `npx prisma migrate dev --name <cambio>`.
- Comprobar que `schema.prisma` y la BD no difieren (0 drift):
  `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code`
- Equivalente al `db pull` inicial, para comparar: `npx prisma db pull --print` sobre una BD creada solo con `init.sql`.

## Endpoints

| Ruta | Rol | Notas |
| --- | --- | --- |
| `POST /feedback` | `OFTALMOLOGO` (dueño de la consulta) | Zod + upsert por `(inference_id, doctor_id)`. `doctor_id` sale del JWT; `predicted_class`, `confidence` y `agreement` se derivan de la inferencia guardada (lo que mande el cliente se ignora). `validated_class: null` = no concluyente y no puede ser gold standard. Siempre responde 200 con la fila guardada. |
| `GET /export/gold-standard?format=json\|csv&since=<ISO>&limit=<n>` | `INVESTIGADOR`, `ADMIN` | Solo `is_gold_standard = true`. Anonimizado: `doctor_id` = HMAC-SHA256 con `EXPORT_HMAC_SECRET`; sin notas, sin ids de paciente/consulta. Cabecera `x-has-more`. El CSV tiene las columnas que lee `scripts/retrain_cycle.py --samples`. |

Orden de clases del ML (¡no es «Normal» = 0!): `0 = Glaucoma`, `1 = Non_Glaucoma`, `2 = Suspicious_Glaucoma`.

## ETL de reentrenamiento

```bash
export DATABASE_URL=... EXPORT_HMAC_SECRET=...
npm run etl:feedback -- --out data/gold.csv --state data/.etl-state.json --min-samples 50
python ../scripts/retrain_cycle.py --samples data/gold.csv
```

`--state` guarda la marca de agua (solo exporta lo validado desde la última corrida);
`--min-samples N` no escribe nada y sale con código 3 hasta acumular N filas nuevas.

## Tests

```bash
npm test                                   # levanta postgres:16-alpine con Testcontainers (requiere Docker)
TEST_DATABASE_URL=postgresql://u:p@host:5432/clearsight_test npm test   # o usa un Postgres existente
```

Con `TEST_DATABASE_URL` el nombre de la BD debe contener `test`: se **recrea su esquema `public`**.
Las migraciones se aplican leyendo `prisma/migrations/*/migration.sql` en orden. Un test
reproduce además la actualización de una BD `init.sql` con datos (esquema aparte).
