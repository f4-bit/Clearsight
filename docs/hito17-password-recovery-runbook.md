# HITO17 - Recuperación de contraseña (R1 + R2)

> **Estado:** R1 (migración/guard de cuotas) y R2 (endpoints/ciclo de token/entrega disabled) implementados y **5.9 QA PASSED** en HITO17. Full integration QA: **23 files / 444 tests**. B8 (proveedor/credenciales reales) sigue pendiente de provisioning y **no bloquea** el cierre de 5.9. No se hizo commit/push.

## 1. Alcance

R2 implementa:

- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- Servicio y puerto de entrega (`DISABLED` por defecto, memory sink solo de pruebas).
- Esquemas estrictos y política de contraseña compartida con el alta administrativa.
- DI Fastify, decoración/tipos, redacción de `token/email/newPassword`.
- Tests unitarios e integración reales con PostgreSQL owned de Testcontainers.

No implementa: frontend, proxy, Azure, `.env` reales, correo real/proveedor, outbox, PHI, PDF, nuevas dependencias de email. El backend expone internamente `/auth/password/*`; el path público previsto es `/api/auth/password/*` detrás de un proxy HTTPS que quita `/api`, pero el proxy no se implementa en este hito.

## 2. Contrato

### Forgot

- Request estricto `{ email: string(email canónico, trim/lowercase, <=255) }`; campos desconocidos `400`.
- Sin sesión, cookie ni Bearer. `Origin` opcional: si está presente se aplica la política exacta de logout (`403` mismatch/null; `503` si falta configuración); si está ausente se permite.
- Cuotas R1 en orden: `FORGOT_IP` (20/3600 s) y después `FORGOT_EMAIL` (3/3600 s). Cada request válido consume IP aunque el email esté agotado.
- `202 { accepted: true }` fijo para conocido/desconocido/inactivo, `DISABLED`, fallo de entrega o fallo post-cuota de lookup/token/auditoría. Solo el fallo del store de cuotas antes del lookup y el `429` son errores observables.
- `429` genérico con `Retry-After >= 1`, independiente del estado de la cuenta.
- `Cache-Control: no-store` en todas las respuestas, incluidas las de error.

### Reset

- Request estricto `{ token: string, newPassword: string }`; campos desconocidos `400`.
- `newPassword` comparte la política del alta: >=12 code points Unicode y <=72 bytes UTF-8; bcrypt cost 12.
- Sin sesión/cookie/Bearer. Token solo en body; `Authorization` no lo sustituye.
- Cuota `RESET_IP` (20/900 s) antes del lookup del token y de bcrypt.
- `204` vacío, sin sesión nueva, sin cookie y sin access token.
- Token inválido/expirado (`expiresAt <= now`)/usado/revocado/usuario inactivo: `401` genérico idéntico.
- Reset efectivo, en una tx auditada:
  - `passwordHash` nuevo cost 12.
  - `tokenVersion + 1` exactamente una vez.
  - `consumedAt` del token usado.
  - revocación de otros reset tokens, todas las sesiones (`PASSWORD_RESET`) y todos los refresh.
  - sin tocar `failedLoginCount`, `lockedUntil` ni `auth_login_buckets`; HU01 se conserva.
- Fallo de store/auditoría/hash: `503` con rollback, sin cambio de contraseña ni consumo.
- Single-use: dos resets concurrentes del mismo token producen exactamente un `204` y un `401`.

## 3. Seguridad de token y entrega

- Token crudo: 32 bytes CSPRNG en base64url (43 caracteres).
- DB: solo SHA-256 lowercase; `PasswordResetToken` existente, expiry absoluto 30 min, append-only.
- El último token comprometido bajo lock de usuario es el único válido; los anteriores se revocan.
- `DISABLED` por defecto: no genera token, no invalida anteriores y no entrega.
- Memory sink: solo por DI de pruebas, instancia local, sin endpoint de inspección ni retención global. Recibe recipient + raw token solo para aserciones.
- La entrega ocurre después del commit. Si falla:
  - la respuesta sigue siendo `202`;
  - se registra un código operativo seguro, sin email/token;
  - se intenta revocar **solo** el token exacto de forma condicional;
  - no se revoca un token más nuevo ni otro usuario.
- No hay garantía de entrega ni outbox. El proveedor real sigue en B8.
- El token no aparece en logs, JSON, cabeceras ni URLs/enlaces.

## 4. Archivos

- `backend/src/services/password-reset.ts`
- `backend/src/services/password-reset-delivery.ts`
- `backend/src/routes/auth.ts`
- `backend/src/schemas/auth.ts`
- `backend/src/app.ts`
- `backend/src/types/fastify-auth.d.ts`
- `backend/src/lib/log-redaction.ts`
- `backend/tests/unit/password-reset.test.ts`
- `backend/tests/password-reset.integration.test.ts`
- `backend/vitest.integration.config.ts`
- `backend/tests/unit/runner-isolation.test.ts`
- R1: migración `20261119020000_password_recovery_quotas`, `AuthRecoveryBucket`, `password-recovery-quota.ts` y sus tests.

## 5. Evidencia ejecutada

| Evidencia QA final (reportada; sin rerun de maker) | Resultado |
|---|---|
| Unit focal R2 | **7 tests** (el conteo 8 incluía `log-redaction`) |
| Unit focal R1+R2 | **19 tests** |
| Unit completo | **27 files / 396 tests** |
| Integration foco R2 | **28 tests**, incluyendo 6 QA nuevos |
| Full integration QA | **23 files / 444 tests** (401 baseline + 15 R1 + 22 R2 + 6 QA) |
| Typecheck | **0** después de los tests QA |
| Build | reutilizado del mismo source maker **0** |
| Docker/cleanup | contenedores/volúmenes propios sin residuos; ajenos intactos |
| `git diff --check` | OK; solo warnings CRLF preexistentes |

No se ejecutó proveedor real, envío de correo, Azure ni `.env` reales. Los 6 tests QA nuevos cubren: default disabled, IP exhaust, 503 uniforme, carreras, no auth substitute y 400 sin consumo de cuota.

## 6. Cobertura de pruebas R2

- Forgot uniforme para known/unknown/inactive y no enumeración.
- `DISABLED` sin token ni invalidación de anteriores.
- Dos forgot secuenciales: solo el último token válido.
- Cuotas forgot email/IP, orden IP→email y aislamiento de login/HU01.
- Cuota reset 20/900 antes de lookup/bcrypt.
- `401` genérico para inválido/expirado/usado/revocado/inactivo.
- Reset exitoso con DB final, nueva/antigua contraseña, JWT previo inválido, refresh previo inválido y sesiones/refresh revocados.
- Preservación de HU01 (contadores, lock y buckets de login).
- Single-use concurrente.
- Reset+forgot race.
- Reset+refresh race.
- Admin deactivation before/concurrent reset/forgot: fail closed and no valid token linked to the old credential.
- Expiración exacta a 30 min.
- Audit rollback y store failure sin consumo/cambio.
- Compensación de entrega fallida sin revocar un token más nuevo.
- Transporte: JSON estricto, Origin opcional, no-store y ausencia de credenciales en respuesta/auditoría.
- Redacción de `req.body.token/email/newPassword` en el test unitario de logging.
- QA final añadió 6 tests R2: default disabled, IP exhaust, 503 uniforme, carreras, no auth substitute y 400 sin consumo de cuota.

## 7. Límites

- 5.9 queda `[x]` con QA PASSED; R1 y R2 no se modificaron en este cierre documental.
- La entrega real de email no está implementada; B8 (proveedor/credenciales) sigue pendiente de provisioning sin bloquear el cierre.
- No hay proxy público `/api/auth/password/*` en este hito.
- No se modifican migraciones históricas, `auth_login_buckets`, `0_init` ni `docker/init.sql`.
- Se mantienen fixtures, ownership markers y safeguards de tests; no se relajaron.
- No se hizo commit/push ni reruns en el cierre documental.
