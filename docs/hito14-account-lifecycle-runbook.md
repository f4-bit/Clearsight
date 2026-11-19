# HITO 14 - Runbook real de ciclo de vida administrativo (5.4/5.6/9.1)

> **Alcance:** `GET /admin/users`, `GET /admin/users/:id` y `PATCH /admin/users/:id` sobre el commit `e42c0cf`.
> Se conserva el contrato de alta `POST /admin/users` de 1.8. No se usó Azure, `.env.azure`, base de
> producción, PHI, correos reales ni credenciales externas. No se cambió schema, migraciones,
> dependencias ni `package-lock.json`. No se hizo commit ni push desde este runbook.

## Precondiciones

- PostgreSQL 16 efímero/owned de Testcontainers; sin `TEST_DATABASE_URL` ni base externa.
- Migraciones A-E e `0_init` sin cambios; no se añadió migración.
- `POST /admin/users` de 1.8 conserva default `OFTALMOLOGO`, `isActive:true` server-owned, cost 12 y auditoría `USER_CREATED`.
- Sin grants clínicos, refresh/logout, reset ni lectura de auditoría en este hito.

## Traza real ejecutada

| Fase | Comando | Resultado |
|---|---|---|
| Typecheck | `npm --prefix backend run typecheck` | exit 0 |
| Unit | `npm --prefix backend run test:unit` | **20 files / 351 tests passed** |
| Unit focalizada lifecycle | `npm --prefix backend run test:unit -- tests/unit/admin-users-lifecycle.test.ts tests/unit/admin-users.test.ts tests/unit/runner-isolation.test.ts` | **3 files / 42 tests passed** |
| Integración lifecycle | `npm --prefix backend run test:integration -- tests/user-lifecycle.integration.test.ts` | **1 file / 24 tests passed** |
| Foco lifecycle + userAdmin | `npm --prefix backend run test:integration -- tests/user-lifecycle.integration.test.ts tests/user-admin.integration.test.ts` | **2 files / 48 tests passed** |
| Integración completa | `npm --prefix backend run test:integration` | **18 files / 343 tests passed (203.56 s)** |
| Build | `npm --prefix backend run build` | exit 0 |
| Diff check | `git diff --check` | exit 0 |
| Limpieza Docker | `docker ps -a` con labels `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true`; `docker volume ls` con el label de ownership | sin contenedores ni volúmenes residuales |

> **Histórico pre-QA conservado:** unit 20/347, unit focalizada 3/38, lifecycle 1/16, foco auth/admin 5/140 y full 18/335. La evidencia final es 20/351, 3/42, 1/24, 2/48 y 18/343.

## Matriz source-test 5.4/5.6/9.1

| Source | Cobertura | Resultado |
|---|---|---|
| `backend/src/schemas/auth.ts` | query estricta (`limit` 20/100, `offset>=0`, `isActive` literal, `q` trim<=255), body PATCH estricto y UUID | unit 20/351 |
| `backend/src/services/admin-users.ts` (`listUsers`, `getUser`, `updateUser`) | lectura paginada/filtrada, actor fresco, locks global+UUID, último admin, revocación, auditoría y rollback | `tests/user-lifecycle.integration.test.ts` 24/24 |
| `backend/src/routes/admin.ts` | `GET` listado/detalle y `PATCH` ADMIN-only, errores 400/401/403/404/409/503, DELETE ausente | incluido en 24/24 |
| `backend/src/services/admin-bootstrap.ts`, `session.ts`, `login-guard.ts` | 1.8/email literal/login/bootstrap sin regresión | histórico foco auth/admin 5/140 (pre-QA) |
| PostgreSQL owned y rol `clearsight_app` | PATCH real con SELECT/INSERT/UPDATE y audit insert; DELETE/TRUNCATE denegados; CURRENT_USER restringido | incluido en 24/24 |

## Comportamiento verificado

- **Lectura:** `GET /admin/users` devuelve `{items,total,limit,offset}`, orden `createdAt DESC id ASC`, filtros `role`/`isActive`/`q` literal case-insensitive; `_` y `%` se escapan. `GET /admin/users/:id` devuelve el DTO de 7 campos seguros, acepta email legacy como string y `404` si no existe. Las lecturas no crean auditoría.
- **PATCH:** body estricto `{email?, fullName?, role?, isActive?}`, al menos un campo; rechaza password/hash/tokenVersion/contadores/actor/grants con `400` sin hash. `fullName` solo no revoca; email/role/isActive incrementan `tokenVersion` exactamente 1 y revocan sesiones/refresh/reset no revocados. Reactivar no revive credenciales antiguas.
- **Orden de autorización:** tras los locks, el actor/sesión frescos se validan antes de revelar la existencia del target. Un actor stale con UUID desconocido responde `403`; un admin válido con target inexistente responde `404`.
- **Último admin:** self-deactivate/self-demote del único admin devuelve `409 LAST_ACTIVE_ADMIN` sin cambios; con otro admin activo se permite y el JWT actual queda revocado. La carrera de dos admins se serializa con el lock global y deja al menos uno activo.
- **Historial:** un `DELETE /admin/users/:id` no implementado responde 404 y no borra ni reasigna consultas, inferencias, feedback ni snapshots. No hay hard delete ni grants clínicos implícitos.
- **Auditoría:** `USER_UPDATED`/`SUCCESS` registra `channel`, `changedFields` y, si aplica, `previousRole`/`newRole`/`previousIsActive`/`newIsActive`; no guarda email/nombre/password. El fallo de auditoría revierte perfil y todas las revocaciones. La denegación del último admin puede registrar `USER_UPDATE_DENIED`/`DENIED` con `reasonCode=LAST_ACTIVE_ADMIN`.

## Límites conocidos

- La API de lectura de auditoría sigue pendiente (9.2).
- ACL/ownership clínico y export siguen pendientes (5.2). `ADMIN` no obtiene datasets clínicos por rol.
- Refresh/logout/cookies (5.8) y reset (5.9) siguen pendientes; no se implementan tokens nuevos ni cookies.
- No hay hard delete, anonimización ni supresión de identidad.
- Release clínica **no** declarada lista.
