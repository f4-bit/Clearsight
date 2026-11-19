# HITO 13 - Runbook real de alta administrativa (task 1.8)

> **Alcance:** `POST /admin/users` con PostgreSQL 16 efímero/owned de Testcontainers.
> No se usó Azure, `.env.azure`, base de producción, PHI, correos reales ni secretos.
> No se hizo commit ni push desde este runbook.

## Precondiciones

- Node/npm y Docker local disponibles; el runner de integración crea su propio contenedor PostgreSQL.
- Sin `TEST_DATABASE_URL`, sin Azure y sin base externa/de desarrollo.
- Migraciones A-E e `0_init` sin cambios; no se añadió migración en este hito.
- `source` y `package-lock.json` sin dependencias nuevas.

## Traza real ejecutada

| Fase | Comando | Resultado |
|---|---|---|
| Typecheck | `npm --prefix backend run typecheck` | exit 0 |
| Unit | `npm --prefix backend run test:unit` | **19 files / 335 tests passed** |
| Integración focalizada admin | `npm --prefix backend run test:integration -- tests/user-admin.integration.test.ts` | **1 file / 24 tests passed (PostgreSQL owned)** |
| Foco auth/admin (histórico pre-QA) | `npm --prefix backend run test:integration -- tests/admin-bootstrap.integration.test.ts tests/auth-sessions.integration.test.ts tests/login-protection.integration.test.ts tests/user-admin.integration.test.ts` | **4 files / 117 tests passed** |
| Integración completa | `npm --prefix backend run test:integration` | **17 files / 319 tests passed (259.43 s)** |
| Build | `npm --prefix backend run build` | exit 0 |
| Limpieza Docker | `docker ps -a` con labels `com.clearsight.test.owner=backend-integration` y `org.testcontainers=true`; `docker volume ls` con el label de ownership | sin contenedores ni volúmenes residuales |

> **Histórico pre-QA conservado, no es el resumen final:** unit 19/333, foco auth/admin 4/117 e integración completa 17/312. La corrida FINAL QA es unit 19/335, focalizada admin 1/24 e integración completa 17/319.

## Evidencia de email literal en PostgreSQL owned

Antes de cambiar el WHERE se comprobó el proveedor real con filas distintas y `findMany({ where: { email: { equals, mode: "insensitive" } } })`:

- `literal_x@example.test` también encontraba `literalAx@example.test` (comodín `_`).
- `literal%@example.test` encontraba todas las direcciones `literal*` (comodín `%`).
- Con `escapeLiteralLike` (`\`, `%`, `_`) cada consulta devolvió solo su fila exacta.

El helper compartido se aplica en bootstrap, login, login guard y alta admin. No se cambió el WHERE a SQL manual ni se filtró en JavaScript.

## Matriz source-test de 1.8

| Source | Cobertura | Resultado |
|---|---|---|
| `backend/src/lib/canonical-email.ts` | contrato compartido login/bootstrap/alta, rechazo de `admin@localhost` y emails Unicode no soportados, escape literal | unit 19/335 |
| `backend/src/services/admin-users.ts` | lock global, actor/sesión frescos en tx, conflicto case-insensitive, USER+auditoría misma tx, rollback ante fallo de auditoría/store | `tests/user-admin.integration.test.ts` 24/24 |
| `backend/src/routes/admin.ts` y `backend/src/app.ts` | `authenticate` + `requireRole("ADMIN")`, DTO estricto, errores seguros 400/401/403/409/503, DI con el Prisma/schema/clock inyectados | incluido en 24/24 |
| `backend/src/services/{admin-bootstrap,session,login-guard}.ts` | mismo email canónico y búsqueda literal en los cuatro caminos | histórico foco 4/117 |
| Rol `clearsight_app` | alta real `201` con CURRENT_USER restringido, sesión/actor/auditoría bajo grants D | incluido en 24/24 |

## Consistencia verificada de identidad

- **Actor fresco:** el servicio relee usuario y sesión dentro de la misma transacción; rol distinto, `tokenVersion` cambiado, cuenta inactiva o sesión revocada/expirada deniegan sin crear USER ni auditoría.
- **Email literal y canónico:** bootstrap, login, login guard y alta comparten normalización/escape; un ADMIN creado por bootstrap se probó con `POST /auth/login` y `/auth/me` reales.
- **Sin grants clínicos implícitos:** `USER_CREATED` solo registra `channel=admin-api` y `assignedRole`; no escribe ni concede acceso a datasets clínicos.

## Límites conocidos

- `GET/PATCH /admin/users`, desactivación, cambio de rol y protección del último admin siguen pendientes (5.4/5.6/9.1).
- La API de lectura de auditoría sigue pendiente (9.2). El refresh/logout/reset siguen pendientes (5.8/5.9).
- ACL/ownership clínico y export siguen pendientes (5.2). El rol `ADMIN` de una cuenta nueva no concede datasets clínicos.
- El formato canónico actual no admite `%`/Unicode en el email; el escape literal queda preparado para filas legacy/futuras.
- No se añadió índice `LOWER(email)` ni migración; colisiones legacy por case quedan para 1.7 sin borrar datos.
- Release clínica **no** declarada lista.
