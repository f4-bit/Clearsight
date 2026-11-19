# HITO 8 - Runbook real de migración segura (task 1.5)

> **Alcance:** ejecución local del wrapper `npm run prisma:deploy` contra PostgreSQL 16 efímero/owned.
> No se usó Azure, `.env.azure`, base de producción, PHI, correos reales ni secretos. No se commitea
> ni se hace push desde este runbook.

## Precondiciones

- Node 24.18 / npm 11 instalados en `backend/`.
- Docker local disponible; PostgreSQL de test creado por Testcontainers o contenedor propio.
- `MIGRATION_DATABASE_URL` (preferida) o `DATABASE_URL` explícita al ejecutar el wrapper.
- Ninguna base externa/de desarrollo; el target debe ser owned por el run.
- Migraciones históricas `0_init` y A/B/C/D sin modificar.

## Fases y comandos

| Fase | Comando | Resultado real |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0 |
| Unit | `npm run test:unit` | 8 files / 109 tests passed |
| Integración focalizada | `npm run test:integration -- tests/migration-deploy.integration.test.ts` | 1 file / 27 tests passed |
| Integración completa | `npm run test:integration` | 12 files / 182 tests passed |

> **Resumen final QA 1.5:** 27 tests focalizados y 182 tests de integración. La corrida histórica
> anterior a la incorporación del test extra de dominio/array implícito quedó en 180; se conserva como
> referencia anterior, no como conteo final.
| Build | `npm run build` | exit 0; genera `dist/services/migration-deployment.js` |
| Prisma validate | `prisma validate --config prisma.migrate.config.ts` con URL sintética | exit 0, sin conexión |
| Prisma generate | `prisma generate --config prisma.migrate.config.ts` con URL sintética | exit 0, sin conexión |
| Docker build | `docker build -f docker/migrate.Dockerfile -t clearsight-migrate-test:<id> .` | build OK |
| Docker LF readiness | mount de árbol LF en `/app/prisma` + URL de conexión inválida | exit 1, `MIGRATION_CONNECTION_FAILED` (no manifest mismatch), sin leak |
| Docker URL inválida | URL malformada con canary | exit 1, `MIGRATION_URL_INVALID`, sin leak |
| Limpieza | `docker image rm <tag propio>` | imagen eliminada; sin `docker prune` |

## Pruebas de portabilidad EOL

- `readMigrationInventory` normaliza solo `CRLF -> LF`; `checksum` es el hash LF canónico.
- `acceptedChecksums` contiene únicamente las dos renderizaciones del mismo SQL canónico: LF y CRLF.
- El CLI real de Prisma desplegó correctamente:
  1. árbol CRLF y repetición desde árbol LF;
  2. árbol LF y repetición desde árbol CRLF.
- Un SQL con un espacio adicional falla por checksum tanto en LF como en CRLF.
- El historial de base de datos nunca se reescribe.

## Fingerprints

| Elemento | SHA-256 |
|---|---|
| `0_init` working tree CRLF (raw) | `b2321cd75b4428748040b77e3e1b5ac1c5528824871cc20fad85ccaccbd4f883` |
| `0_init` canónico LF / blob Git | `0e6e51bdb110d70a9bc979e1e94d99bf0195e5120e366c9efe4c34b167028502` |
| `docker/init.sql` canónico LF | `0e6e51bdb110d70a9bc979e1e94d99bf0195e5120e366c9efe4c34b167028502` |
| manifiesto baseline final | `6F536BBF78DF941DB52D2D3AA5BB1FCE980545930B706AAB2F49953B3BAE8C14` |

## Inventario de catálogo cubierto

- Tablas/columnas/tipos/nulabilidad/defaults.
- PK/FK con columnas, tabla referenciada, acciones delete/update y deferrability.
- Checks, constraints, índices y triggers de las tablas del baseline.
- Objetos inesperados: vistas, matviews, foreign tables, secuencias, tipos/dominios/composites/
  ranges/multiranges, funciones/procedimientos/agregados y extensiones del schema objetivo.
- Bookkeeping `_prisma_migrations`: shape, nombres, checksums y estado temporal; nunca `logs`.

## Stop conditions

- Target no owned, URL ausente/ambigua, `.env.azure` o secreto visible: detener.
- Historial fallido/incompleto/desconocido, checksum drift u objeto inesperado: fallo cerrado sin CLI.
- Falla de conexión/permisos/migración: no resolve adicional, no retry global, no reescritura de historial.
- No se declara deploy real en Azure ni base productiva; el DSN administrativo con `CREATEROLE` queda
  como precondición futura de 8.x.
