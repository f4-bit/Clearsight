# HITO16 — Refresh web, logout y origen público (5.8)

> Alcance implementado: login + refresh + logout, política de origen/cookie y
> servicio transaccional con tests. **No** incluye 5.9 (forgot/reset), proxy,
> frontend, Azure, migraciones ni cambios de schema. **5.8 cerrada por QA
> PASSED** (HITO16).

## Configuración

| Variable | Regla |
|---|---|
| `AUTH_PUBLIC_ORIGIN` | Origen exacto `http(s)` sin wildcard, credenciales, path, query ni hash. Producción exige `https`. `http` solo se acepta para `localhost`/`127.0.0.1`/`[::1]` en entorno no productivo. Vacío/ausente ⇒ endpoints de cookie `503`. Inválido ⇒ arranque falla cerrado. |

La cookie es siempre `clearsight_refresh` con `HttpOnly`, `Secure`,
`SameSite=Lax`, host-only y `Path=/api/auth`. La expiración no supera la sesión
absoluta de 7 días. No se deshabilita `Secure` en producción ni como excepción
silenciosa.

## Contrato HTTP

| Ruta | Comportamiento |
|---|---|
| `POST /auth/login` | JSON actual + `Set-Cookie`; `Origin` obligatorio; `403` antes de KDF/DB si falta/null/mismatch/cross-site; `429` conserva `Retry-After`; `503` sin cookie. |
| `POST /auth/refresh` | Sin body ni Bearer; solo cookie; devuelve `accessToken`, `tokenType`, `expiresIn`; rota single-use; `401` genérico en token inválido/expirado/revocado/versión/inactivo/reuso. |
| `POST /auth/logout` | Bearer de sesión válida ⇒ `204`; revoca sesión y cadena con auditoría y limpia cookie; cookie sola no autoriza; `Origin` presente pasa el mismo guard. |

**H1 — lectura estricta:** “sin body ni Bearer” describe el mecanismo de
autenticación del refresh, no una prohibición de coexistencia de headers. El
request recomendado no envía body ni `Authorization`; si llegan, nunca se usan
como credencial ni sustituyen la cookie, y su presencia sola no es error.

`/auth/me` no cambia. Las respuestas de credenciales llevan
`Cache-Control: no-store`, incluidas las rechazadas.

## Transacción y locks

- Refresh/logout: lectura inicial no bloqueante de ids, luego locks
  `user → session → refresh` y relectura fresca. No se confía en la lectura
  previa.
- Rotación: consume el padre, inserta exactamente un sucesor (puntero de padre
  único), audita y firma dentro de la misma transacción. Si firma/auditoría/DB
  falla, se revierte y no se emite cookie de éxito.
- Reuso: confirma revocación de sesión + todos sus refresh + auditoría y
  **después** responde `401`. Si la auditoría falla, `503` con rollback.
- Refresh/reuso, refresh/logout y refresh/cambio de rol concurrentes no producen
  dos hijos ni deadlocks en las pruebas de QA.

## Pruebas ejecutadas — QA final HITO16 (PASSED)

| Comando | Resultado |
|---|---|
| `npm --prefix backend run test:unit` | **25 files / 377 tests passed** |
| `npm --prefix backend run test:integration` | **21 files / 401 tests passed (270 s)** |
| `tests/refresh-session.integration.test.ts` | **21 tests** (incluidos en el full; QA añadió casos de guard/cookie) |
| `npm --prefix backend run typecheck` | exit `0`, repetido después de los tests de QA |
| `npm --prefix backend run build` | reutilizado del mismo source, exit `0` |

- El nombre real de la suite es `tests/refresh-session.integration.test.ts`;
  `auth-refresh.integration.test.ts` y `auth-origin.integration.test.ts` fueron
  solo nombres prospectivos y no existen.
- PostgreSQL/Ryuk propios limpiados; `redkeep_db` ajeno intacto; sin `.env`,
  `.env.azure`, Azure, PHI ni correos reales.
- QA añadió casos a la integración (21 tests) y la aserción de cookie duplicada
  con el mismo valor en unit.

## Límites y notas

- No se añadió dependencia: serialización/parseo de cookie con utilidades
  internas estrictas. Un valor repetido, vacío, citado o con alfabeto/longitud
  incorrectos se trata como cookie ausente.
- Logging: se redactan `Authorization`, `Cookie`, `Set-Cookie` y campos de
  credenciales del body (`password`, `newPassword`, `currentPassword`,
  `refreshToken`). **H3:** serializers custom futuros requieren revisión contra
  esa lista; no hay fuga actual.
- **H1:** “sin body ni Bearer” es el mecanismo de autenticación, no una
  prohibición de coexistencia de headers. Un body o `Authorization` presentes
  nunca se usan como credencial ni sustituyen la cookie; su presencia sola no es
  error.
- **H2 (hardening futuro):** el reuso de un token ya consumido puede escribir
  auditoría/locks en cada intento; D19 no exige rate-limit adicional. Es un
  límite conocido de amplificación, no una regresión abierta, y no se promete
  resuelto.
- El enrutado público `/api/auth/*` y el proxy que quita `/api` son contrato
  documental; no se implementa proxy ni frontend en este hito.
- 5.8 cerrada por QA PASSED; 5.9 (forgot/reset) sigue pendiente.
