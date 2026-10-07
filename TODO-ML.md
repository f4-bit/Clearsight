# TODO y Estado del Servicio de Machine Learning (ClearSight)

Este documento centraliza el estado actual, la arquitectura implementada, los elementos faltantes y las decisiones pendientes del servicio de inferencia de Machine Learning, sirviendo como contexto operativo para las siguientes fases de desarrollo.

---

## 1. Estado Actual del Código

- **Rama activa:** `feat/ml` (commit `86d59f9` subido a `origin/feat/ml`).
- **Arquitectura:** Microservicio de inferencia desacoplado implementado en FastAPI (`ml/service/main.py`), diseñado para ejecutarse en un servidor GPU remoto independiente (GTX 1060 6 GB).
- **Procesamiento:**
  - Asíncrono mediante cola de trabajos (`ml/service/queue.py`) con soporte para Redis o fallback en memoria.
  - Concurrencia unitaria (`batch_size=1`, 1 worker) para proteger la VRAM de la GPU Pascal (6 GB).
- **Control de calidad y tipado:**
  - `ruff` (linting): 100% aprobado.
  - `mypy` (typechecking estricto): 100% aprobado en 31 archivos.
  - `pytest`: 7 pruebas unitarias aprobadas (`ml/tests/`).

---

## 2. Artefactos y Modelos (Hugging Face)

Los modelos están registrados con commit fijado y hash SHA-256 en `ml/models/manifest.json`:

1. **Segmentador de Disco y Copa Óptica (Keras / FPN ResNet18):**
   - Repositorio: `F4-bit/Clearsight-CD-Segmentation-CNN-Base-model`
   - Commit: `9c895971e4da6e69d3c4aab7087d2fb7d4ef7a1f`
   - Archivo: `best_fpn_resnet18 - 13042026.h5` (166 MB, SHA-256: `0b9b573c...`)
   - Entrada: 512×512 píxeles con preprocesamiento CLAHE.

2. **Clasificador Multimodal Fold 4 (PyTorch / EfficientNet-B3):**
   - Repositorio: `F4-bit/fold_4_efficientnet_b3`
   - Commit: `f008baa66e6ee36b1dca15ee9afbb670bffbcb26`
   - Archivo: `best_model_fold4_efficientnet_b3.pth` (134 MB, SHA-256: `4f9bee56...`)
   - Entrada: Tensor 5 canales (384×384) + CDR (1 dim) + 11 variables clínicas normalizadas.

3. **Clasificador Multimodal Fold 4 (PyTorch / ResNet-50):**
   - Repositorio: `F4-bit/fold_4_resnet_50`
   - Commit: `1cf2396be8d78cf5850bff1bf9a1bebb717dbbda`
   - Archivo: `best_model_fold4_resnet50.pth` (289 MB, SHA-256: `53805e98...`)
   - Entrada: Tensor 5 canales (384×384) + CDR (1 dim) + 11 variables clínicas normalizadas.

4. **Swin-Tiny (Fold 4):**
   - **Estado:** NO DISPONIBLE (repositorio privado o faltante con error 401). Descartado de la primera versión; los pesos del ensemble se normalizan 50% ResNet-50 / 50% EfficientNet-B3.

---

## 3. Pipeline End-to-End Implementado (`ml/inference/pipeline.py`)

```text
1. Solicitud (InferenceRequest con URL firmada HTTPS + 11 variables clínicas)
   ↓
2. Descarga y validación de seguridad (SSRF protection: host allowlist, max 25 MB)
   ↓
3. Detección del centro del disco óptico por luminancia CIE-LAB (cropping_step.py)
   ↓
4. Recorte inicial 512×512 con CLAHE
   ↓
5. Preprocesamiento de segmentación (doble CLAHE de paridad experimental)
   ↓
6. Inferencia FPN-ResNet18 (TensorFlow/Keras, umbrales: disco > 0.40, copa > 0.33)
   ↓
7. Postprocesamiento morfológico (componente conexa mayoritaria, disco = unión)
   ↓
8. Control de Calidad Anatómico:
   - Si no hay disco/copa, copa > disco o CDR fuera de rango:
     → Marca estado REVIEW_REQUIRED (no fuerza diagnóstico).
   ↓
9. Cálculo de Cup-to-Disc Ratio (CDR):
   - cdr_input = sqrt(área_copa / área_disco)  [fórmula del entrenamiento]
   - cdr_vertical = altura_copa / altura_disco [métrica secundaria]
   ↓
10. Recorte anatómico para clasificadores (384×384 centrado en disco segmentado)
   ↓
11. Generación de imagen de 5 canales: [R, G, B, R_CLAHE, G_CLAHE] / 255.0
   ↓
12. Vectorización y estandarización Z-score de las 11 variables clínicas
   ↓
13. Inferencia de clasificadores (ResNet-50 y EfficientNet-B3 en PyTorch)
   ↓
14. Ensemble de probabilidades (Softmax ponderado 50/50)
   ↓
15. Subida de artefactos visuales a MinIO (máscara y overlay PNG)
   ↓
16. Respuesta consolidada al Backend con métricas y metadatos de auditoría
```

---

## 4. Elementos Faltantes y Bloqueantes Críticos

### A. Parámetros de Normalización Clínica (`clinical_mean` y `clinical_std`)
- **Problema:** Los checkpoints de los clasificadores fueron entrenados con Z-score sobre 11 variables clínicas específicas de Fold 4. Estos valores no están empaquetados dentro de los archivos `.pth`.
- **Acción requerida:** Proveer las listas de 11 valores flotantes en las variables de entorno `ML_CLINICAL_MEAN_JSON` y `ML_CLINICAL_STD_JSON` (orden estricto de `manifest.json`: Age, Gender, dioptre_1, dioptre_2, astigmatism, Phakic/Pseudophakic, Pneumatic, Perkins, Pachymetry, Axial_Length, VF_DM).

### B. Salida de `nvidia-smi` del Servidor GPU
- **Problema:** La GPU de destino es una GTX 1060 6 GB (arquitectura Pascal, compute capability 6.1). 
- **Restricción técnica:** NVIDIA eliminó el soporte de Pascal en CUDA 13.x. Se diseñó el Dockerfile sobre CUDA 12.6.3 (`nvidia/cuda:12.6.3-cudnn-runtime-ubuntu22.04`), que requiere un driver mínimo `>= 525.60.13` y recomendado `>= 560.35.05`.
- **Acción requerida:** Ejecutar `nvidia-smi` en el servidor remoto para verificar driver de host y compatibilidad. Si el driver es inferior a 560, ajustar la imagen base a CUDA 11.8.

### C. Configuración de MinIO
- **Problema:** El servicio requiere buckets de destino para persistir las máscaras y overlays generados (`ML_MASK_BUCKET` y `ML_OVERLAY_BUCKET`).
- **Acción requerida:** Configurar endpoint, credenciales y buckets en `docker/ml-service.env` (usando `docker/ml-service.env.example` como plantilla).

---

## 5. Tareas Técnicas Pendientes de Implementación

1. **Construcción y Prueba del Contenedor Docker:**
   - Iniciar el daemon de Docker con NVIDIA Container Toolkit en el servidor Ubuntu.
   - Ejecutar `docker compose -f docker/ml-service.compose.yml build`.
   - Validar que TensorFlow (`2.16.1`) y PyTorch (`2.7.0+cu126`) coexisten en el mismo runtime sin conflictos de bibliotecas dinámicas.

2. **Verificación de Carga Real de los Pesos:**
   - Realizar una descarga de prueba de los 3 artefactos desde Hugging Face y validar los checksums SHA-256.
   - Probar `tf.keras.models.load_model('...h5', compile=False)` para confirmar si requiere deserializar funciones de pérdida personalizadas (`DiceLoss`, `FocalLoss`).

3. **Integración con el Backend Principal:**
   - Actualmente los routers en `backend/app/api/consultations.py` y el worker `backend/app/workers/inference.py` son stubs de 1 línea.
   - Conectar el backend para que genere las URLs firmadas de MinIO, envíe la solicitud `POST /v1/inferences` y consulte el estado vía `GET /v1/inferences/{job_id}`.

4. **Fase 2 de Optimización y Explicabilidad:**
   - **Exportación ONNX (FP16):** Exportar los modelos PyTorch a ONNX Runtime para reducir el uso de VRAM y acelerar la inferencia en la GTX 1060 (módulo previsto en `ml/inference/onnx_serving.py`).
   - **Grad-CAM:** Desarrollar los mapas térmicos de atención sobre las capas convolucionales (módulo previsto en `ml/inference/gradcam.py`).
   - **MLOps y Reentrenamiento:** Implementar los ciclos batch con MLflow (`ml/mlflow/`, `ml/training/` y `scripts/retrain_cycle.py`).

---

## 6. Decisiones y Preguntas Abiertas

1. **Estrategia ante Desacuerdo de Modelos:**
   - ¿Qué umbral de diferencia de probabilidades entre ResNet-50 y EfficientNet-B3 debe disparar el estado `REVIEW_REQUIRED`?
2. **Visualización Clínica de CDR:**
   - ¿Se mostrará en la interfaz médica el CDR basado en área (`cdr_input`) o el CDR vertical anatómico tradicional (`cdr_vertical`), o ambos con su respectiva aclaración?
3. **Manejo de Reintentos de Red:**
   - Con URLs firmadas de MinIO, ¿cuál será el TTL mínimo asignado por el backend para asegurar que no expiren mientras la tarea espera en la cola de inferencia?