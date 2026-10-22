# Reporte Técnico y Hoja de Ruta Arquitectónica: Plataforma Clínica de Detección de Glaucoma

---

## 1. Visión General del Sistema

El sistema es una plataforma de apoyo al diagnóstico oftalmológico diseñada para procesar imágenes de fondo de ojo (retinografías de ojo izquierdo y derecho) junto con datos clínicos del paciente. Su propósito es emitir una clasificación trifásica (**Normal**, **Sospechoso**, **Glaucoma**) con explicabilidad visual (Grad-CAM) y habilitar un ciclo cerrado de retroalimentación médica (*Human-in-the-Loop*) para el reentrenamiento periódico de los modelos.

### Objetivos Clave de Infraestructura

* **Baja latencia y paralelismo:** Procesar retinografías bilaterales (OD/OS) concurrentemente sin bloquear la interfaz.
* **Seguridad y privacidad clínica:** Cumplir con estándares de desacoplamiento de datos sensibles (anonimización/pseudonimización y eliminación de metadatos EXIF).
* **Escalabilidad desacoplada:** Separar la gestión de la aplicación web del cómputo intensivo de inferencia y del ciclo de MLOps.

---

## 2. Arquitectura Global del Sistema

```
 [ Frontend Clínico: React / Next.js ]
                  │
                  │ HTTPS / JWT
                  ▼
 [ API Gateway & Core Backend: FastAPI ]
    │                      │                     │
    ├─► PostgreSQL         ├─► Object Storage    └─► Message Broker (Redis)
    │   (Metadatos,        │   (MinIO / S3)               │
    │    Pacientes Anon,   │   (Imágenes RAW              ▼
    │    Feedback Médico)  │    y Grad-CAM)      [ Ingestion & Task Queue ]
    │                      │                              │
    │                      │                              ▼
    │                      │             [ ML/DL Inference Worker: Celery ]
    │                      │              ├── Preprocesamiento (OpenCV/Albumentations)
    │                      │              ├── Inferencia Paralela (ONNX Runtime)
    │                      │              ├── Explicabilidad (Grad-CAM)
    │                      │              └── Clasificador Multimodal (DL + ML)
    │                      │                              │
    └──────────────────────┴──────────────────────────────┘
                                  ▲
                       Reentrenamiento Batch
                                  │
                   [ Pipeline MLOps: MLflow ]

```

### Flujo de Datos Extremo a Extremo (E2E)

1. **Captura:** El oftalmólogo ingresa datos del paciente y carga las imágenes (OD, OS o ambas).
2. **Sanitización:** El backend elimina metadatos incrustados (EXIF/DICOM), asigna un identificador universal único (UUID) no correlacionable y sube el archivo a almacenamiento de objetos.
3. **Despacho:** El backend registra la consulta en PostgreSQL con estado `PENDIENTE` y encola una tarea en Redis.
4. **Cálculo:** El worker de inferencia consume la tarea, ejecuta el preprocesamiento, genera el tensor por lote (batch), realiza el pase hacia adelante (*forward pass*) en ONNX Runtime, computa el mapa Grad-CAM y guarda la predicción en la base de datos.
5. **Visualización y Feedback:** El médico inspecciona el resultado y valida o rectifica el diagnóstico, almacenando la tupla como verdad fundamental (*ground truth*) para el siguiente ciclo de entrenamiento.

---

## 3. Especificación Técnica por Capas

### A. Frontend (Interfaz Médica)

* **Pila recomendada:** Next.js / React con Tailwind CSS y componentes sobrios (ej. Shadcn UI).
* **Requisitos funcionales:**
* Carga y validación en cliente de archivos de imagen (formatos, dimensiones mínimas de 512 px sobre el lado corto, peso).
* Formulario clínico con las once variables que consume el modelo, exactamente las declaradas en `ml/service/schemas.py` (`ClinicalFeatures`): `Age`, `Gender`, `dioptre_1`, `dioptre_2`, `astigmatism`, `Phakic/Pseudophakic`, `Pneumatic`, `Perkins`, `Pachymetry`, `Axial_Length`, `VF_DM`. Todas numéricas y obligatorias: el contrato usa `extra="forbid"`, así que no se admiten campos adicionales, renombrados ni omitidos.
* No se capturan datos clínicos fuera de esas once variables. Un campo que no exista en `ClinicalFeatures` no se pide en la interfaz, para no prometer datos que el sistema no puede sostener. La excavación que reporta el cockpit proviene de la segmentación, no de una estimación manual.
* Visor bilateral interactivo con control deslizante de opacidad para superponer el mapa Grad-CAM sobre la retina original. OD se renderiza a la izquierda y OS a la derecha, sin espejado.
* Módulo de validación diagnóstica con opciones: *Confirmar diagnóstico del modelo*, *Rectificar a otra clase* o *Marcar como no concluyente*, junto con un campo de observaciones clínicas. La opción *no concluyente* exige que `validated_class` admita `null`; el contrato actual lo declara obligatorio entre 0 y 2 y debe corregirse.



### B. Backend y Capa de Seguridad Médica

* **Pila recomendada:** FastAPI (Python), autenticación JWT/OAuth2.
* **Módulos obligatorios:**
* **Sanitizador de imágenes:** Limpieza de cabeceras EXIF/TIFF antes de persistir cualquier archivo para evitar filtración de nombres o datos de equipos clínicos.
* **Módulo de Pseudonimización:** La base de datos civil y la base de datos de imágenes se vinculan únicamente mediante un `patient_uuid`.
* **RBAC (Control de Acceso Basado en Roles):**
* *Oftalmólogo:* Crear consultas, ver historiales de sus pacientes, emitir feedback.
* *Investigador/Auditor:* Descarga anonimizada de lotes validados para reentrenamiento.
* *Administrador:* Gestión de cuentas y monitoreo de logs del sistema.





### C. Almacenamiento y Base de Datos

* **Object Storage (MinIO o AWS S3):**
* Bucket `raw-retinas/`: Almacena imágenes originales sanitizadas organizadas por `/año/mes/uuid_imagen.jpg`.
* Bucket `gradcam-overlays/`: Almacena las visualizaciones térmicas generadas.


* **Base de Datos Relacional (PostgreSQL):**
* `patients`: `id (UUID)`, `age`, `gender`, `clinical_history_flags (JSONB)`.
* `consultations`: `id (UUID)`, `patient_id`, `doctor_id`, `created_at`, `status`, `clinical_features (JSONB)`.
* `images`: `id (UUID)`, `consultation_id`, `eye_side (OD/OS)`, `storage_path`, `hash_md5`.
* `inferences`: `id (UUID)`, `image_id`, `job_id`, `predicted_class`, `confidence`, `probabilities (JSONB)`, `cdr`, `cdr_vertical`, `quality (JSONB)`, `artifacts (JSONB)`, `elapsed_seconds`, `gradcam_path`, `model_version`.
* `clinical_feedback`: `id (UUID)`, `inference_id`, `doctor_id`, `validated_class (NULL = no concluyente)`, `agreement (BOOLEAN, NULL = sin comparación)`, `doctor_notes`, `is_gold_standard (BOOLEAN)`.

* **Vocabulario de estado (único, no libre):** `consultations.status` debe usar el mismo enum que el servicio de inferencia (`ml/service/schemas.py` → `JobStatus`): `QUEUED`, `DOWNLOADING`, `LOCALIZING`, `SEGMENTING`, `CLASSIFYING`, `COMPLETED`, `REVIEW_REQUIRED`, `FAILED`. Hoy `ConsultationCreate.status` es un string libre con valor por defecto `PENDIENTE`, lo que rompe la trazabilidad de la cola.

* **Contratos de integración (fuente de verdad: `ml/service/schemas.py`):**
* El frontend nunca invoca el servicio de ML. Envía al gateway, y el gateway reenvía con `Authorization: Bearer <ML_API_TOKEN>`.
* Alta asíncrona: `POST /v1/inferences` responde `202` con `JobAccepted` (`inference_id`, `job_id`, `status`).
* Progreso: `GET /v1/inferences/{job_id}` devuelve `JobResponse` (`status`, `stage`, `message`, `result`). El frontend hace polling sobre `status` y no interpreta `stage` como enum.
* Cada ojo es una inferencia independiente: `InferenceRequest.eye_side` es `OD` u `OS`, nunca ambos.
* `InferenceResult` es la forma exacta del resultado: `label`, `confidence`, `probabilities`, `model_predictions`, `cdr`, `cdr_vertical`, `quality`, `artifacts`, `model_versions`, `elapsed_seconds`. El frontend no debe derivar ni completar campos ausentes.



### D. Motor de Inferencia y Paralelización

* **Pila:** Celery Worker con soporte de ONNX Runtime (CPU o CUDA Execution Provider).
* **Estrategia de Optimización:**
* **Conversión a ONNX:** Exportar los modelos de visión desde PyTorch/TensorFlow a formato Open Neural Network Exchange (`.onnx`) con precisión FP16.
* **Ejecución por ojo:** cada ojo es una inferencia independiente (`eye_side` = `OD` | `OS`) con su propio `job_id`. La agregación bilateral (consenso OD/OS) ocurre al consolidar resultados, no como un tensor conjunto `[2, 3, H, W]` en un único pase hacia adelante.
* **Dos CDR distintos, nunca intercambiables:** `cdr = sqrt(area_cup / area_disc)` alimenta al modelo como variable de entrada; `cdr_vertical = altura_cup / altura_disc` es la métrica de reporte clínico. Ambos viajan en `InferenceResult`.
* **Compuerta de calidad:** si no se detectan contornos válidos de disco y copa, si `Area(cup) > Area(disc)`, si `cdr` cae fuera de `[0, 1]` o si la resolución es insuficiente, el job termina en `REVIEW_REQUIRED` y la clasificación automática se suprime. La UI muestra la advertencia y bloquea el commit de reentrenamiento hasta que el médico la reconozca.
* **Pipeline multimodal:** dos backbones con vástago de 5 canales (`[R, G, B, R_CLAHE, G_CLAHE]`) — ResNet-50 y EfficientNet-B3 — sobre el recorte del disco óptico reescalado a 384 × 384. Cada backbone concatena sus *embeddings* con `[cdr] + ClinicalFeatures` en una cabeza MLP. La salida final es el promedio ponderado 50/50 de las softmax de ambos modelos.





### E. MLOps y Reentrenamiento Periódico

* **Pila:** MLflow (Model Registry, Tracking Server y almacenamiento de artefactos en MinIO).
* **Ciclo de Reentrenamiento:**
* **Criterio de disparo:** Se activa por lote cada vez que se acumulan $N$ registros validados en `clinical_feedback` (o mediante ejecución programada mensual).
* **Curaduría de datos:** Se extraen únicamente los registros con `is_gold_standard = True`.
* **Evaluación automatizada:** El nuevo modelo debe superar o igualar el área bajo la curva (ROC-AUC / F1-Score) del modelo en producción sobre un conjunto de prueba fijo antes de ser promovido al estado *Production* en MLflow.



---

## 4. Matriz de División de Roles y Responsabilidades

Para un equipo multidisciplinar de ingeniería, las cargas de trabajo se distribuyen en cuatro frentes técnicos:

| Rol Asignado | Responsabilidades Principales | Entregables Clave |
| --- | --- | --- |
| **Ingeniero Frontend (UI/UX Clínico)** | • Desarrollo del portal web en Next.js/React.

• Implementación del visor de imágenes con canvas/overlay Grad-CAM.

• Interfaz de validación médica (Human-in-the-Loop).

• Conexión con endpoints del backend mediante OpenAPI/REST. | • Portal web funcional y responsive.

• Componente visor de retinografías.

• Formularios con validación en cliente. |
| **Ingeniero Backend & Seguridad** | • API REST en FastAPI con autenticación y RBAC.

• Sanitización de imágenes (limpieza EXIF) y subida a Object Storage.

• Modelado e implementación de PostgreSQL.

• Encolamiento asíncrono con Celery y Redis. | • API documentada con Swagger/OpenAPI.

• Scripts de migración de BD (Alembic).

• Módulo de carga y sanitización segura. |
| **Ingeniero de ML & Optimización (Serving)** | • Exportación y optimización de modelos a ONNX / TensorRT.

• Construcción del worker de inferencia en Celery.

• Implementación del pipeline de preprocesamiento y Grad-CAM.

• Benchmark de latencia (PyTorch nativo vs. ONNX Runtime). | • Worker de inferencia dockerizado.

• Script de exportación y testing ONNX.

• Módulo generador de Grad-CAM. |
| **Ingeniero MLOps & Arquitectura de Datos** | • Configuración y despliegue del servidor MLflow y MinIO.

• Pipeline de extracción de feedback validado (ETL).

• Script automatizado de reentrenamiento y validación de métricas.

• Orquestación general (Docker Compose para desarrollo local). | • `docker-compose.yml` integral del sistema.

• Servidor MLflow con Model Registry activo.

• Pipeline de reentrenamiento batch funcional. |

---

## 5. Cronograma de Implementación por Fases

```
[Semana 1-2] Fase 1: Entorno Base y Core de Inferencia
  ├── Contenedores Docker (PostgreSQL, Redis, MinIO, MLflow)
  ├── Exportación del modelo DL a ONNX y validación de equivalencia matemática
  └── Configuración inicial de FastAPI y conexión a base de datos

[Semana 3-4] Fase 2: Inferencia Asíncrona y Lógica Backend
  ├── Integración Celery + Redis + ONNX Runtime
  ├── Generación de mapas de calor Grad-CAM
  └── Sanitización de cabeceras de imagen y almacenamiento desacoplado

[Semana 5-6] Fase 3: Frontend Clínico y Módulo de Feedback
  ├── Vistas de autenticación y carga de retinografías en React
  ├── Visor interactivo con capas de opacidad para Grad-CAM
  └── Endpoints y componentes para la validación del diagnóstico médico

[Semana 7-8] Fase 4: Integración MLOps, Pruebas y Despliegue
  ├── Pipeline de extracción de feedback y reentrenamiento batch
  ├── Pruebas de carga y medición de latencias bajo concurrencia
  └── Documentación final y despliegue en servidor institucional o nube

```
