# Proposal: consolidate-backend-ml-azure

## Why

La rama `feat/backend-ml-consolidation` integra piezas que hoy no forman un contrato verificable de extremo a extremo: el servicio ML asume MinIO al arrancar (`ml/service/storage.py:59-70`, `ml/service/queue.py:84,157`), el worker backend solo espera `COMPLETED`/`FAILED` y descarta parte del resultado (`backend/src/workers/inference.worker.ts:33-47,67,74-83`), la persistencia de evidencia es parcial (`backend/src/repositories/inference.repo.ts:30-45`), el alta de usuarios es pública con rol arbitrable (`backend/src/routes/auth.ts:18-60`) y no existe contrato único de ejecución clínica, artefactos, permisos ni PDF. Sin ese contrato, frontend y QA no pueden construir ni validar sobre una fuente de verdad estable y Azure no es desplegable de forma segura.

## What Changes

- Se documenta la consolidación prioritaria **backend + ML + Azure + seguridad + PDF básico**. El PDF pasa a ser obligatorio para declarar completitud de una ejecución requerida.
- Se define la unidad clínica: paciente, consulta y ejecución son entidades distintas; una ejecución analiza **una** retinografía con lateralidad `OD`/`OS` como metadato y un snapshot clínico inmutable. Un reanálisis crea una **nueva** ejecución enlazada y nunca sobrescribe evidencia pasada.
- Se separan explícitamente: ejecución ML, etapa de pipeline, estado de artefacto, PDF y estado agregado de consulta. `COMPLETED` de ML no equivale a consulta completada. `REVIEW_REQUIRED` detiene la espera automática y exige resolución humana; su regla clínica de cierre queda pendiente y bloquea solo esa transición.
- Se define el catálogo de artefactos (`mask`, `overlay`, `result`, `pdf`, `gradcam`, `shap`) con estados `NOT_SUPPORTED`, `NOT_REQUESTED`, `PENDING`, `AVAILABLE`, `FAILED`, causa segura, reintentabilidad y ausencia explícita. `mask`, `overlay`, `result` y PDF básico son obligatorios para una ruta exitosa normal cuando el pipeline los produce; en revisión se permite evidencia parcial sin fingir éxito.
- Se establece una referencia de artefacto estable y estructurada (tipo, storage lógico, bucket/container, key exacta, contentType e integridad), sin persistir SAS, presigned URLs ni URLs externas arbitrarias. Backend autoriza y firma descargas; si la URL expira, el frontend solicita una nueva.
- Se especifican invariantes públicos de ML: `POST /v1/inferences` recibe `signed image_url`, no multipart ni CDR de entrada; respuesta aceptada y consulta recuperable; worker at-least-once/idempotente; etiquetas desconocidas rechazadas sin mapeo inventado; clases canónicas `0 Glaucoma`, `1 Non_Glaucoma`, `2 Suspicious_Glaucoma`.
- Se define idempotencia persistida y concurrente para el backend, con alcance autenticado y `Idempotency-Key` obligatoria en la creación canónica de ejecuciones y en cualquier alias de reanálisis: misma key y payload reproduce el mismo `202` con el mismo identificador de servidor; misma key con payload distinto responde conflicto; si se pierde el `202`, se reintenta con la misma key sin exigir un id no recibido. El modelo resuelto se fija en la primera solicitud; la URL firmada dinámica no forma parte del fingerprint. SHA-256 de bytes sanitizados verifica contenido; el fingerprint clínico nunca se usa para negar un reanálisis legítimo ni para revelar duplicados entre usuarios.
- Se especifican roles `ADMIN`, `OFTALMOLOGO`, `INVESTIGADOR` con mínimo privilegio y default deny, matriz por endpoint/recurso/datos, ownership de casos, bootstrap de administrador controlado, desactivación que preserva autoría, bloqueo de login/sesiones y protecciones del último administrador. Se fija `HU01`: cinco fallos **consecutivos** bloquean la cuenta durante 15 minutos; un éxito intermedio reinicia el contador y un éxito durante el bloqueo no lo levanta. Admin e investigador requieren grant explícito al conjunto de datos, sin acceso clínico global por rol.
- Se define auditoría append-only de acciones sensibles y la política de borrado físico excepcional solo para cuentas sin actividad; supresión de identidad distinta de desactivación y sin automatización hasta aprobación.
- Se especifica el PDF básico: identificación pseudónima, ojo, inferencia, versión de snapshot, información clínica con unidades solo cuando el mapeo esté verificado, probabilidades, versiones de modelo, calidad, CDR, imagen original **sanitizada** embebida junto con `mask` y `overlay`, fechas, warnings y aviso de apoyo a investigación; sin secretos ni URLs temporales. No se usan referencias como reemplazo visual en una ruta exitosa normal; el reporte parcial de revisión documenta la falta y no declara completitud. Reintentar el PDF es idempotente; cambios de feedback o explicaciones generan nueva versión de reporte.
- Se documenta Azure como despliegue **aislado por ejecución** con recursos creados por el run, tags de entorno, cleanup en `finally` y verificación de borrado. Presupuesto numérico, suscripción, alcance y duración no están acordados: **bloquean el deploy**, no el diseño. No se lee ni se usa `.env.azure` como evidencia.
- Se incluye una tabla de endpoints con estado, request/response, errores, autenticación, ownership y compatibilidad para que frontend pueda implementar sin leer código fuente.
- Se mantiene fuera de alcance el frontend. También quedan como entregables posteriores: historial/filtros/paginación, administración/auditoría operativa, PDF enriquecido, APIs/documentación adicional y explicabilidad Grad-CAM/SHAP. RF07 unimodal y RF15 comparación quedan pendientes de aclaración y **no se implementan ni se simulan**.
- Se prohíbe afirmar cumplimiento de RNF sin medición. Los umbrales del SRS (p95, concurrencia, AUC, cobertura, disponibilidad) se documentan como metas a medir, no como resultados.

## Capabilities

### New Capabilities

- `clinical-case-execution`: paciente, consulta y ejecución; lateralidad, snapshot clínico inmutable, IDs requeridos explícitos, reanálisis, conjunto de ojos requerido, precedencia de estados y completitud separada de ML.
- `artifact-evidence`: catálogo y ciclo de vida de artefactos, referencias estables, almacenamiento lógico, URLs firmadas bajo demanda, estados de ausencia/fallo y reconciliación.
- `inference-orchestration`: contrato público del servicio ML, cola/worker, idempotencia, recuperación, mapeo de clases, persistencia de resultados y reintentos acotados.
- `clinical-api-contract`: contrato HTTP para frontend: endpoints, cuerpos, errores, autenticación, ownership, compatibilidad y funciones diferidas marcadas como no implementadas.
- `identity-access-audit`: roles, autenticación, bloqueo por intentos consecutivos, sesiones con decisión técnica propuesta, administración segura, auditoría append-only y borrado/supresión.
- `clinical-pdf-report`: PDF básico obligatorio para completitud, contenido mínimo, ausencia de secretos, idempotencia y versionado.
- `azure-isolated-deployment`: provisión y limpieza aislada por ejecución, seguridad de recursos, verificación de eliminación y bloqueos de decisión.
- `azure-deployment-automation`: capacidad inicial del repo para provisión Azure aislada por ejecución, etiquetada, con manifest y cleanup verificado; incluye la verificación E2E de pipeline.
- `azure-readiness-and-init-sql`: capacidad inicial del repo para inicialización de base de datos, switch ONNX, compatibilidad de hosts Azure Blob, feedback source opcional y Dockerfiles operativos.
- `ml-serving-optimization`: capacidad inicial del repo para normalización clínica, Grad-CAM diferido, export ONNX FP16 y benchmark de latencia.

### Modified Capabilities

Ninguna baseline versionada. `git ls-files -- openspec` devuelve vacío: las specs locales bajo `openspec/specs/` están ignoradas y se consultaron solo como contexto, no como baseline oficial de entrega. Por eso las tres capacidades anteriores se registran como **New Capabilities iniciales** con requisitos completos bajo `ADDED Requirements`.

## Impact

- **Documentación**: este change es la fuente de verdad para backend, ML, Azure, seguridad y contrato de frontend. Ninguna funcionalidad descrita se declara implementada.
- **Backend/Node**: rutas, autenticación/RBAC, repositorios, worker BullMQ, almacenamiento y contrato de persistencia. Evidencia estática actual: `backend/src/routes/auth.ts`, `backend/src/routes/inferences.ts`, `backend/src/workers/inference.worker.ts`, `backend/src/repositories/inference.repo.ts`, `backend/src/services/storage.ts`, `backend/prisma/schema.prisma`.
- **ML/Python**: arranque de storage, contrato `/v1/inferences`, pipeline, estados y publicación de artefactos. Evidencia estática actual: `ml/service/storage.py`, `ml/service/queue.py`, `ml/inference/pipeline.py`, `ml/service/schemas.py`.
- **Base de datos**: nuevas entidades/campos para ejecución, evidencia, PDF, auditoría e idempotencia; cambios de estado y migración condicionada. Baseline actual: `docker/init.sql`, `backend/prisma/migrations/20261027000000_prisma_alignment/migration.sql`.
- **Azure**: script de despliegue aislado y limpieza; no se ejecuta ni se despliega en este change. `.env.azure` está prohibido como entrada y como evidencia.
- **Frontend (excluido de implementación)**: recibe contrato completo de endpoints y artefactos. No se modifica `frontend/`; los mocks actuales no son fuente de verdad.
- **Dependencias y seguridad**: no se agregan dependencias ahora (incluida `SQLAlchemy`, que no está en `ml/pyproject.toml`). `DatabaseFeedbackSource` queda opcional y no prioritario hasta decisión explícita.
- **Pruebas**: se documentan suites focalizadas y E2E, pero no se ejecutan en este change. Las pruebas destructivas nunca usarán una base de datos ajena o de desarrollo.
- **Riesgos**: vacíos de producto sobre cierre de revisión, cambio del conjunto de ojos tras cierre, retención, consentimiento/privacidad y supresión de identidad quedan marcados como bloqueos delimitados; no se inventan reglas.
