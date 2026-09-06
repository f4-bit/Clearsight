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
* Carga y validación en cliente de archivos de imagen (formatos, dimensiones mínimas, calidad).
* Formulario clínico compacto: edad, presión intraocular (PIO), excavación papilar estimada y antecedentes familiares.
* Visor bilateral interactivo con control deslizante de opacidad para superponer el mapa Grad-CAM sobre la retina original.
* Módulo de validación diagnóstica con opciones: *Confirmar diagnóstico del modelo*, *Rectificar a otra clase* o *Marcar como no concluyente*, junto con un campo de observaciones clínicas.



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
* `consultations`: `id (UUID)`, `patient_id`, `doctor_id`, `created_at`, `status`.
* `images`: `id (UUID)`, `consultation_id`, `eye_side (OD/OS)`, `storage_path`, `hash_md5`.
* `inferences`: `id (UUID)`, `image_id`, `predicted_class`, `confidence`, `probabilities (JSONB)`, `gradcam_path`, `model_version`.
* `clinical_feedback`: `id (UUID)`, `inference_id`, `doctor_id`, `validated_class`, `agreement (BOOLEAN)`, `doctor_notes`, `is_gold_standard (BOOLEAN)`.



### D. Motor de Inferencia y Paralelización

* **Pila:** Celery Worker con soporte de ONNX Runtime (CPU o CUDA Execution Provider).
* **Estrategia de Optimización:**
* **Conversión a ONNX:** Exportar los modelos de visión desde PyTorch/TensorFlow a formato Open Neural Network Exchange (`.onnx`) con precisión FP16.
* **Batching Bilateral:** Si el médico envía ambos ojos, se forma un tensor conjunto de dimensión $[2, 3, H, W]$ para procesar ambos hemisferios oculares en un único pase hacia adelante.
* **Pipeline Híbrido:**
1. Red Convolucional / Vision Transformer $\rightarrow$ Extrae el vector de características (*embeddings*) del fondo de ojo.
2. Clasificador Tabular (Random Forest / XGBoost / MLP) $\rightarrow$ Concatena embeddings + variables clínicas $\rightarrow$ Emite probabilidad final.





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
| **Ingeniero Frontend (UI/UX Clínico)** | • Desarrollo del portal web en Next.js/React.<br>

<br>• Implementación del visor de imágenes con canvas/overlay Grad-CAM.<br>

<br>• Interfaz de validación médica (Human-in-the-Loop).<br>

<br>• Conexión con endpoints del backend mediante OpenAPI/REST. | • Portal web funcional y responsive.<br>

<br>• Componente visor de retinografías.<br>

<br>• Formularios con validación en cliente. |
| **Ingeniero Backend & Seguridad** | • API REST en FastAPI con autenticación y RBAC.<br>

<br>• Sanitización de imágenes (limpieza EXIF) y subida a Object Storage.<br>

<br>• Modelado e implementación de PostgreSQL.<br>

<br>• Encolamiento asíncrono con Celery y Redis. | • API documentada con Swagger/OpenAPI.<br>

<br>• Scripts de migración de BD (Alembic).<br>

<br>• Módulo de carga y sanitización segura. |
| **Ingeniero de ML & Optimización (Serving)** | • Exportación y optimización de modelos a ONNX / TensorRT.<br>

<br>• Construcción del worker de inferencia en Celery.<br>

<br>• Implementación del pipeline de preprocesamiento y Grad-CAM.<br>

<br>• Benchmark de latencia (PyTorch nativo vs. ONNX Runtime). | • Worker de inferencia dockerizado.<br>

<br>• Script de exportación y testing ONNX.<br>

<br>• Módulo generador de Grad-CAM. |
| **Ingeniero MLOps & Arquitectura de Datos** | • Configuración y despliegue del servidor MLflow y MinIO.<br>

<br>• Pipeline de extracción de feedback validado (ETL).<br>

<br>• Script automatizado de reentrenamiento y validación de métricas.<br>

<br>• Orquestación general (Docker Compose para desarrollo local). | • `docker-compose.yml` integral del sistema.<br>

<br>• Servidor MLflow con Model Registry activo.<br>

<br>• Pipeline de reentrenamiento batch funcional. |

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
