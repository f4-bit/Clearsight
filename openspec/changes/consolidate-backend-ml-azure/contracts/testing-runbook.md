# Runbook de pruebas incremental — consolidate-backend-ml-azure

> **Naturaleza:** documento de planificación. No ejecuta pruebas ni declara resultados. Separa comandos **CURRENT** (verificados contra el repo actual) de comandos **FUTURO** (no existen todavía y no deben presentarse como disponibles). Ninguna fase usa producción, datos clínicos reales sin governance, `.env.azure`, secretos, IDs de suscripción ni datos personales reales en el payload clínico. Excepción futura: los correos reales solo se usan para envío controlado autorizado, fuera del payload clínico; el worker productor no maneja PHI. Este runbook no commitea ni ejecuta por sí mismo; un orquestador/commit posterior no convierte la documentación en ejecución.

## 0. Reglas no negociables

1. **Producción prohibida.** Ninguna fase se ejecuta contra una base, bucket, cola o suscripción de producción. Si no se puede demostrar el target aislado, la fase se detiene.
2. **Ownership marker.** Toda DB/almacén/cola usada en pruebas destructivas debe haber sido creada o adoptada explícitamente para el run, con un marcador de ownership. **Que el nombre contenga `test` no es garantía suficiente.**
3. **Stop de pasos peligrosos.** Si falta una precondición, el target no es aislado, aparece un secreto/ID sensible o no hay cleanup verificable, se detiene la fase y se reporta. No se improvisa un bypass.
4. **Sin secretos y sin datos personales en payload.** No se leen ni imprimen `.env.azure` ni credenciales. No se versionan direcciones reales, datos personales, tokens, SAS ni presigned URLs. Los correos reales son una excepción futura únicamente para envío controlado autorizado, fuera del payload clínico; el worker productor no maneja PHI.
5. **Fallar no se oculta.** Un test fallido bloquea el commit de esa fase. Los fallos preexistentes se registran como baseline y no se presentan como éxito.
6. **Una tarea coherente.** Cada tarea se autoverifica y, si es de alto riesgo, requiere QA independiente. No se mezcla un arreglo masivo con una tarea.
7. **Commits/push.** Este change documental no se commitea aquí. La autorización global del usuario para commits/push en el flujo de trabajo ya está dada; no se pide de nuevo por fase. Un orquestador/commit posterior se hará cuando corresponda y no convierte este runbook en ejecución. El commit se limita a la fase/documentación verificada.

## 1. Mapa de fases

| Fase | Objetivo | DB/cloud | Riesgo | Estado |
|---|---|---|---|---|
| 0 | Entorno, versiones y smoke mínimo | No | Bajo | CURRENT |
| 1 | Documentación y specs estáticas | No | Bajo | CURRENT |
| 2 | Unidad/contratos focalizados | DB efímera solo si aplica | Medio | CURRENT parcial / FUTURO aislado |
| 3 | PostgreSQL/Redis/MinIO efímeros con ownership marker | Sí, efímero | Alto | **NO LISTA con compose raíz**; FUTURO compose test-only/Testcontainers |
| 4 | Stub ML y fault injection | No real | Medio | CURRENT parcial / FUTURO casos |
| 5 | ML local real con pesos y golden tolerances | No cloud | Alto | CURRENT con pesos / FUTURO golden |
| 6 | E2E Azure completo y cleanup | Azure real | Muy alto | FUTURO, bloqueado por B6 |
| B | Benchmarks separados (p95 full-flow, concurrencia) | Entorno aprobado | Alto | FUTURO |

## 1.1 Evidencia INITIAL BASELINE — 2026-11-18

> Evidencia suministrada por el arquitecto y registrada sin emails, IDs de suscripción ni salidas sensibles. Todos los comandos de esta evidencia estuvieron disponibles; ninguno se marca como no disponible.

| Elemento | Resultado observado |
|---|---|
| Node | `v24.18.0` |
| npm | `11.16.0` |
| Python | `3.11.14` |
| pytest | `9.0.3` |
| Docker CLI | `28.5.1` (daemon **no** verificado) |
| Azure CLI | `2.91.0`, lectura read-only, default `Enabled`/`AzureCloud`, `group list` `[]`; **sin creación de recursos** |
| Comando ML ejecutado | `python -m pytest ml/tests/test_service.py ml/tests/test_clinical_normalization.py ml/tests/test_manifest.py -q` con `PYTEST_DISABLE_PLUGIN_AUTOLOAD=1` temporal, restaurado en `finally` para evitar plugins externos |
| Resultado exacto | **7 passed, 1 warning, 6.85s** |
| Warning | `StarletteDeprecationWarning` de `httpx` vs `TestClient`; sugiere `httpx2`; **no tocar dependencias automáticamente** |
| Alcance cubierto | `test_service` con `create_app(initialize_runtime=False)` y health; `clinicalNormalization` (5 casos); `manifest` (1 caso) |
| Fuera de alcance de esta evidencia | ML real, Azure, DB, Redis, Docker daemon y suite backend |

## 2. Fase 0 — Entorno, versiones y smoke mínimo

**Objetivo:** confirmar toolchain y contexto sin importar código pesado, sin levantar servicios y sin leer secretos.

**Precondiciones:** repo en la rama esperada; shell local; no se requiere Docker para los comandos de versión.

**Comandos CURRENT:**

```powershell
git status --porcelain=v1 -b
node --version
npm --version
python --version
docker --version
az version
openspec status --change consolidate-backend-ml-azure
```

**Notas verificadas del repo:**

- `az` está instalado; el arquitecto reportó Azure CLI 2.91.0 y un contexto default `Enabled`/`AzureCloud` leído en modo read-only. Eso es solo un prerequisito: no autoriza gasto ni despliegue.
- No se pide login ni se elige suscripción de nuevo de forma genérica; si el contexto no está activo, se detiene y se reporta.
- No se ejecutan imports de modelos, `npm test`, `docker compose up` ni scripts E2E en esta fase.

**Stop:** si falta una herramienta, si el contexto Azure no es el esperado o si algún comando imprime credenciales/IDs sensibles.

**Criterio de salida:** versiones registradas y estado del repo conocido; sin servicios iniciados y sin secretos en la salida.

## 3. Fase 1 — Documentación y specs estáticas

**Objetivo:** validar que el change documental es coherente, sin ejecutar código productivo.

**Precondiciones:** fase 0 completada.

**Comandos CURRENT:**

```powershell
openspec validate consolidate-backend-ml-azure --strict
openspec status --change consolidate-backend-ml-azure
git diff --check
git diff --stat
```

**Criterio de salida:** validación estricta sin errores, sin whitespace errors y con un diff limitado a documentación. Si falla, se corrige la documentación y se repite; no se avanza a fases con servicios.

## 4. Fase 2 — Unidad y contratos focalizados

**Objetivo:** probar contratos puros (schemas, normalización, manifiesto, servicio ML con stubs) sin tocar cloud real.

**Precondiciones:** fase 1 verde. Para comandos que usan DB, leer la sección de peligro de `globalSetup`.

### 4.1 Peligro del runner backend (verificado)

- `backend/package.json` define `test: "vitest run"`.
- `backend/vitest.config.ts:6` fuerza `globalSetup: ["tests/global-setup.ts"]` para **toda** ejecución, incluso si se pasa un archivo focalizado.
- `backend/tests/global-setup.ts:24-47`:
  - si existe `TEST_DATABASE_URL`, exige que el nombre de la base contenga `test` y ejecuta `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`;
  - si no existe, levanta un contenedor PostgreSQL efímero (testcontainers).
- Por tanto, **`npm --prefix backend run test -- tests/schemas.test.ts` NO es un comando aislado seguro**: dispara el setup destructivo igualmente. No se recomienda contra una DB compartida o de desarrollo.

### 4.2 Comandos CURRENT seguros o acotados

```powershell
# Estático, sin DB ni servicios
npm --prefix backend run typecheck

# ML con stubs; no usa Azure real ni DB
python -m pytest ml/tests/test_service.py -q
python -m pytest ml/tests/test_clinical_normalization.py -q
python -m pytest ml/tests/test_manifest.py -q
```

### 4.3 Comandos CURRENT que requieren DB efímera/ownership

```powershell
# Solo con contenedor efímero (por defecto) o TEST_DATABASE_URL creada/adoptada para el run.
# No usar una DB de desarrollo/compartida.
npm --prefix backend run test -- tests/repositories.test.ts
npm --prefix backend run test -- tests/schemas.test.ts
```

**FUTURO (no escribir ahora):** un `backend/vitest.unit.config.ts` sin `globalSetup` y un script `test:unit` para tests puros. Hasta que exista, no se debe afirmar que un test focalizado está libre del setup destructivo.

**Comando FUTURO propuesto (no disponible):**

```powershell
# FUTURO: requiere crear backend/vitest.unit.config.ts y el script test:unit
npm --prefix backend run test:unit -- tests/schemas.test.ts
```

**Stop:** si el comando intenta conectarse a una DB no aislada, si el contenedor no puede crearse o si aparece un error preexistente no registrado.

## 5. Fase 3 — PostgreSQL, Redis y MinIO efímeros con ownership marker

**Objetivo:** probar integración local de DB/cola/storage sin tocar recursos ajenos.

**Precondiciones:**

- Fase 2 verde en los contratos que no requieren DB.
- Run ID explícito, por ejemplo `CLEARSIGHT_TEST_OWNERSHIP=<run-id>`.
- DB creada o adoptada para el run y marcada; `TEST_DATABASE_URL` no apunta a desarrollo/producción.
- Docker local disponible; puertos libres o configuración aislada.
- Compose test-only verificado con puertos, red y volúmenes aislados, o Testcontainers con ownership explícito; el compose raíz no se usa.
- No se usa `.env.azure`.

**Aislamiento del proyecto compose (verificado en `docker-compose.yml`):**

- `name: clearsight` (línea 1) fija el nombre base del proyecto; `docker compose` sin `-p` puede reutilizar el proyecto de desarrollo.
- Los volúmenes nombrados `postgres-data`, `redis-data`, `minio-data`, etc. (líneas 189-195) no llevan labels de run/ownership por defecto.
- La red `clearsight` es `external: true` (líneas 197-200) y puede ser compartida; **no se borra jamás** desde el run.
- Por eso la receta CURRENT con el compose raíz **NO está lista para ejecución segura** si no se pueden aislar puertos, red y volúmenes sin cambios de fuente. No se usa `docker compose up` literal. La fase queda **NO LISTA PARA EJECUTAR** hasta disponer de un compose test-only verificado o de Testcontainers con ownership explícito.

**Comandos CURRENT ilustrativos (placeholders, NO ejecutar literal):**

```powershell
# <proyecto-efimero-unico> NO es suficiente por sí solo.
docker compose -p <proyecto-efimero-unico> config --quiet
docker compose -p <proyecto-efimero-unico> config --services
docker compose -p <proyecto-efimero-unico> ps
```

`config --quiet` y `config --services` validan el merge efectivo sin imprimir valores de entorno. **No ejecutar `docker compose config` completo**, porque puede volcar secretos.

**Si y solo si** existe un compose test-only verificado con puertos, red y volúmenes aislados y labels de ownership:

```powershell
# FUTURO: condicionado a un compose test-only verificado, no al compose raíz.
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> up -d postgres redis minio
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> ps
```

- Antes de `up`, comprobar colisiones de puertos; si hay colisión, **abortar**, no reutilizar ni reasignar el puerto de otro servicio.
- Verificar que la red no sea la `clearsight` externa compartida; si lo es, no borrar la red ni tocar recursos fuera del manifest.
- Verificar labels `project`/`run`/ownership en volúmenes y recursos; el nombre único del proyecto **no** es garantía suficiente.

**Preferencia segura:** Testcontainers con ownership explícito para tests backend, en lugar de levantar el compose raíz. No se crea infraestructura en este change.

**Regla de ownership (obligatoria):**

- Antes de truncar/borrar, el runner debe comprobar el marcador de ownership y el target permitido. **No se permite `DROP`/`TRUNCATE` solo porque el nombre contenga `test`.**
- El `global-setup` actual no implementa ese marcador; su único guard es el nombre de la DB. Por eso no se usa contra una DB ajena.
- **FUTURO:** script/helper de guard que verifique `CLEARSIGHT_TEST_OWNERSHIP`, cree una tabla/marker y aborte si no coincide. No se escribe en este change.

**Tests CURRENT que usan esta fase:**

```powershell
# Solo con stack/DB aislados y ownership verificado
npm --prefix backend run test -- tests/migrations.test.ts
npm --prefix backend run test -- tests/repositories.test.ts
npm --prefix backend run test -- tests/rbac.test.ts
```

**Cleanup (solo con ownership verificado):**

```powershell
# Nunca -v por defecto. Primero verificar que el proyecto y los volúmenes tienen labels del run
# y que no son de desarrollo. Si no se puede demostrar, no borrar nada.
docker compose -p <proyecto-efimero-unico> -f <compose-test-only-verificado.yml> down
```

- **No usar `-v`** sin comprobar labels `project`/`run`/ownership y el manifest del run.
- No borrar la red externa `clearsight` ni recursos fuera del manifest.
- Si el cleanup no puede demostrar ownership, se reporta `pending` y no se declara destruido.

**Stop:** si el marker no coincide, si el target no está allowlisted, si hay colisión de puertos, si se reutiliza el compose raíz o la red externa compartida, si faltan labels de ownership, si el stack reutiliza volúmenes de desarrollo o si el cleanup afectaría datos ajenos.

## 6. Fase 4 — Stub ML y fault injection

**Objetivo:** cubrir fallos del contrato sin ML real ni Azure real.

**Casos mínimos:**

- clave duplicada / idempotencia concurrente;
- pérdida del `202` y reintento con la misma key;
- `REVIEW_REQUIRED` sin auto-complete ni conversión manual;
- artefacto faltante (`mask`/`overlay`/PDF);
- token/credencial revocada;
- Azure Blob stub (sin Azure real);
- host no allowlisted, URL expirada, payload inválido, etiqueta desconocida.

**Comandos CURRENT (baseline, no cubren todos los casos nuevos):**

```powershell
python -m pytest ml/tests/test_service.py -q
python -m pytest ml/tests/test_azure_readiness.py -q
```

**FUTURO:** tests backend/ML nuevos para los casos anteriores. Hasta que existan, se etiquetan como `FUTURO` y no se declaran ejecutados. Cualquier comando backend que use DB sigue el guard de la fase 3.

**Stop:** si un test requiere Azure real, si inyecta datos clínicos reales o si el fallo se enmascara con un mock que no reproduce el contrato.

## 7. Fase 5 — ML local real con pesos y golden tolerances

**Objetivo:** verificar readiness y estabilidad numérica con pesos locales, sin cloud.

**Precondiciones verificadas en el repo:**

- `ml/models/manifest.json` existe (versión, clases canónicas, 11 features, umbrales, ensemble).
- `models_cache/` contiene pesos/ONNX locales: `efficientnet_b3.fp16.onnx`, `resnet50.fp16.onnx`, checkpoints `.pth` y segmentación `.h5`.
- No se versionan pesos ni rutas personales; no se imprimen rutas con datos sensibles.

**Comandos CURRENT:**

```powershell
python -m pytest ml/tests/test_manifest.py -q
python -m pytest ml/tests/test_cdr.py -q
python -m pytest ml/tests/test_ensemble.py -q
python -m pytest ml/tests/test_onnx_serving.py -q
```

**Golden tolerances (FUTURO):** comparar probabilidades de clase, CDR y artefactos contra fixtures dorados con tolerancias declaradas. Si falta un peso o un fixture, la fase se detiene; no se sustituye por una salida inventada.

**Stop:** pesos ausentes/corruptos, diferencias fuera de tolerancia no explicadas, o intento de usar Azure real.

## 8. Fase 6 — E2E Azure completo y cleanup

**Objetivo:** validar el flujo backend Blob → ML → persistencia → PDF → descarga → feedback/export, con negative-auth y cleanup final.

**Precondiciones bloqueantes (B6 parcial, no deployment ready):**

- presupuesto numérico, duración y scope del run confirmados;
- contexto default correcto confirmado **justo antes** de crear;
- permisos/quota verificados con dry-run o lecturas;
- manifest de recursos y cleanup en `finally` con verificación de residuos;
- sin `.env.azure`, sin IDs/nombres de suscripción en docs o logs;
- datos sintéticos o dataset autorizado (por ejemplo PAPILA); nunca PHI real sin governance.

**Estado actual verificado:**

- El contexto CLI read-only está satisfecho; **no** prueba capa gratuita, cuotas, RBAC de creación ni permiso de gasto.
- `scripts/test_azure_e2e.py` existe, pero cubre el **servicio ML** (health, submit, polling, CDR/probabilidades), no el flujo backend completo. Se etiqueta como **CURRENT PARCIAL**, no como E2E completo.
- No existe un script de E2E completo ni un script `e2e` en `package.json`. **No usar `npm run e2e`** (no existe).

**Comando CURRENT parcial (solo si hay un ML service autorizado):**

```powershell
python scripts/test_azure_e2e.py --base-url <endpoint-autorizado>
```

**FUTURO (no disponible):** script de E2E completo backend/Blob/ML/DB/PDF/descarga/feedback/export, con negative-auth y cleanup verificado. Se etiqueta `FUTURO` hasta que exista y esté revisado.

**Stop:** cualquier recurso creado sin tag/manifest, falta de cleanup, secreto en salida, target no confirmado o intento de reutilizar recursos ajenos.

## 9. Benchmarks separados (p95 full-flow, concurrencia)

**Objetivo:** medir RNF sin declarar cumplimiento anticipado.

**Estado actual:**

- `scripts/benchmark_latency.py` existe, pero mide **forward** de clasificadores (PyTorch vs ONNX) con un checkpoint; no mide el flujo completo carga→resultado.
- No se usa como evidencia del p95 del SRS ni de concurrencia.

**FUTURO:**

- benchmark de p95 **full-flow** (carga→resultado) con volumen y entorno declarados;
- 50 solicitudes concurrentes;
- PDF HU08 (≤15 s) con plantilla/numeración;
- cobertura, AUC y disponibilidad con metodología explícita.

**Regla:** reportar valores observados, entorno y límites; no afirmar cumplimiento sin evidencia.

## 10. Inventario de comandos: CURRENT vs FUTURO

| Comando | Estado | Seguridad |
|---|---|---|
| `node --version`, `npm --version`, `python --version`, `docker --version`, `az version` | CURRENT | Seguro, read-only. |
| `openspec validate consolidate-backend-ml-azure --strict` | CURRENT | Seguro, documental. |
| `npm --prefix backend run typecheck` | CURRENT | Estático, sin DB. |
| `npm --prefix backend run test` | CURRENT | **Destructivo**: dispara `globalSetup`; requiere DB efímera/ownership. |
| `npm --prefix backend run test -- tests/schemas.test.ts` | CURRENT | **También dispara `globalSetup`**; no es aislado. |
| `python -m pytest ml/tests/test_service.py -q` | CURRENT | Stubs, sin cloud real. |
| `python -m pytest ml/tests/test_onnx_serving.py -q` | CURRENT | Requiere pesos locales. |
| `docker compose -p <proyecto> config --quiet` / `config --services` | CURRENT | Valida merge efectivo sin imprimir secretos. |
| `docker compose -p <proyecto> up ...` sobre el compose raíz | **NO LISTO** | `name: clearsight`, volúmenes sin labels y red externa compartida; no ejecutar literal. |
| Testcontainers con ownership explícito / compose test-only verificado | FUTURO | Preferido para Fase 3; no crear infraestructura en este change. |
| `scripts/e2e-backend.ps1` | CURRENT | E2E local parcial; requiere stack/seed; no usar contra producción. |
| `scripts/test_azure_e2e.py` | CURRENT PARCIAL | Solo ML service; no flujo backend completo. |
| `scripts/benchmark_latency.py` | CURRENT | Solo forward; no p95 full-flow. |
| `npm run e2e` | **NO EXISTE** | No usar ni documentar como disponible. |
| `backend/vitest.unit.config.ts` + `test:unit` | FUTURO | Aislaría tests puros sin `globalSetup`. No crear en este change. |
| Guard de ownership marker | FUTURO | Requerido antes de automatizar fases destructivas. |
| E2E Azure completo | FUTURO | Requiere B6 confirmado y cleanup. |
| Benchmark p95 full-flow | FUTURO | Requiere script y entorno aprobado. |

## 11. Disciplina de entrega por fase

1. **Autoverificación:** ejecutar primero los comandos focalizados de la fase y los checks del brief; ampliar solo si el riesgo lo exige.
2. **Fallo = stop:** si un test falla, no se hace commit de esa fase; se corrige o se reporta bloqueo con comando y error exactos.
3. **Baseline:** los errores preexistentes se registran como baseline; no se presentan como éxito ni se “arreglan” fuera del alcance.
4. **QA independiente:** las tareas de alto riesgo (migraciones, auth/sesiones, storage dual, PDF, Azure) requieren revisión independiente además de la autoverificación.
5. **Commit/push:** la autorización global del usuario para commits/push ya está dada; no se pide de nuevo por fase. Este runbook no commitea por sí mismo; el orquestador/commit posterior se hará cuando corresponda. Solo se commitea documentación/pruebas verificadas de una tarea coherente; tests fuente futuros por hito.
6. **Sin atajos:** no se usa un mock para declarar un E2E real, no se usa el nombre `test` como guard y no se lee `.env.azure`.
