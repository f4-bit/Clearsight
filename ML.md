# Especificación Técnica del Pipeline de Machine Learning (ClearSight)

Este documento detalla la arquitectura algorítmica, transformaciones matemáticas, contratos de datos y flujo de ejecución del subsistema de Machine Learning para la detección y clasificación triclase de glaucoma (*Normal*, *Sospechoso*, *Glaucoma*).

---

## 1. Visión General del Pipeline

El pipeline procesa retinografías de fondo de ojo en conjunto con 11 variables clínicas mediante una arquitectura híbrida de dos fases:
1. **Fase de Visión y Segmentación Anatómica:** Localización del disco óptico, segmentación semántica de disco y copa, control de calidad anatómico y derivación de la relación copa-disco (Cup-to-Disc Ratio, CDR).
2. **Fase de Clasificación Multimodal:** Re-proyección del recorte sobre la imagen original, ingeniería de características multi-canal (5 canales), fusión vectorial con biomarcadores clínicos y ensamble de redes neuronales convolucionales.

```text
               [ Retinografía Original (JPG/PNG) + 11 Variables Clínicas ]
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FASE 1: PROCESAMIENTO ANATÓMICO Y SEGMENTACIÓN (TensorFlow / Keras)                    │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 1. Decodificación y validación de resolución (mínimo 512×512 px)                       │
│ 2. Detección de centroide del disco óptico vía luminancia CIE-LAB (filtro Gaussiano)  │
│ 3. Recorte cuadrado de 512×512 píxeles con padding constante (0) en bordes             │
│ 4. Preprocesamiento CLAHE (canal L, clipLimit=2.0, tileGrid=8×8)                       │
│ 5. Inferencia FPN-ResNet18 (salida [512, 512, 3]: Fondo, Disco, Copa)                  │
│ 6. Binarización por umbrales empíricos:                                                │
│    - Disco Óptico: P(disco) > 0.40                                                     │
│    - Copa Óptica:  P(copa)  > 0.33                                                     │
│ 7. Postprocesamiento morfológico: extracción de componente conexa mayoritaria          │
│ 8. Verificación de reglas anatómicas de calidad:                                       │
│    - Existencia de contornos de disco y copa                                           │
│    - Área(Copa) ≤ Área(Disco)                                                          │
│    - CDR ∈ [0.0, 1.0]                                                                  │
│ 9. Cálculo de métricas clínicas:                                                       │
│    - CDR Modelo (Área):   sqrt(Área_Copa / Área_Disco)                                 │
│    - CDR Clínico (Vertical): Altura_Copa / Altura_Disco                                │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ FASE 2: CLASIFICACIÓN MULTIMODAL Y ENSAMBLE (PyTorch / timm)                           │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ 10. Mapeo de coordenadas del disco segmentado de vuelta a la imagen original           │
│ 11. Recorte dinámico centrado en disco (margen=100 px, límites: [600, 1000] px)       │
│ 12. Redimensionamiento a 384×384 píxeles (interpolación INTER_AREA)                    │
│ 13. Generación de tensor de 5 canales:                                                 │
│     Canal 0: Rojo (R)                                                                  │
│     Canal 1: Verde (G)                                                                 │
│     Canal 2: Azul (B)                                                                  │
│     Canal 3: Rojo realzado con CLAHE (resalta bordes y reflectancia del disco)         │
│     Canal 4: Verde realzado con CLAHE (maximiza contraste vascular)                    │
│ 14. Estandarización Z-score de las 11 variables clínicas mediante estadísticas Fold 4 │
│ 15. Inferencia paralela/secuencial:                                                    │
│     - ResNet-50 (Fold 4, entrada 5 canales + CDR + 11 clínicas)                        │
│     - EfficientNet-B3 (Fold 4, entrada 5 canales + CDR + 11 clínicas)                  │
│ 16. Ensamble de probabilidades (Softmax ponderado 50% / 50%)                           │
│ 17. Generación de overlay visual y persistencia en Object Storage (MinIO)              │
└────────────────────────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼
             [ Diagnóstico Consolidado, Confianza, CDR y Artefactos Visuales ]
```

---

## 2. Fase 1: Localización, Segmentación y CDR

### 2.1 Localización Autónoma del Disco Óptico (`ml/inference/localization.py`)
En el flujo experimental histórico (`ml-raw/cropping_step.py`), el recorte requería máscaras de ground truth para calcular alertas. En producción, la localización se independiza de cualquier máscara:
1. La imagen se transforma de espacio BGR a **CIE-LAB**.
2. Se aísla el canal de luminancia **L**, donde el disco óptico presenta la reflectancia más alta.
3. Se aplica un **desenfoque Gaussiano profundo** (kernel de $151 \times 151$ o ajustado a la dimensión menor de la imagen) para difuminar vasos sanguíneos y artefactos retinianos.
4. Mediante `cv2.minMaxLoc`, se localizan las coordenadas $(c_x, c_y)$ del punto de luminancia máxima, definiendo el centro estimado del disco óptico.
5. Se extrae una ventana de $512 \times 512$ píxeles centrada en $(c_x, c_y)$. Si el cuadro excede los bordes de la retinografía, se aplica padding constante con ceros (`cv2.copyMakeBorder`).
6. Se registra el contexto de desplazamiento espacial:
   $$\text{offset}_x = c_x - 256, \quad \text{offset}_y = c_y - 256$$
   permitiendo proyectar cualquier punto detectado en el recorte de vuelta a las coordenadas de la imagen original.

### 2.2 Segmentación Semántica FPN-ResNet18 (`ml/inference/segmentation.py`)
- **Arquitectura:** Feature Pyramid Network (FPN) con encoder ResNet18 preentrenado.
- **Canales de Salida:** 3 clases semánticas:
  - Clase 0: Fondo / Retina peripapilar.
  - Clase 1: Disco Óptico (anillo neurorretiniano).
  - Clase 2: Copa Óptica (excavación central).
- **Paridad de Preprocesamiento (Doble CLAHE):**  
  En el entrenamiento experimental (`ml-raw/experimento_proyecto.ipynb`), las imágenes guardadas por `cropping_step.py` ya incluían CLAHE en el canal L, y el generador de FPN volvía a aplicar CLAHE adaptativo sobre RGB. El módulo `apply_segmentation_preprocessing` reproduce estrictamente esta secuencia para preservar la distribución de intensidades con la que convergieron los pesos.
- **Binarización y Limpieza (`ml/inference/postprocessing.py`):**
  - Umbralización probabilística por canal: $P(\text{disco}) > 0.40$ y $P(\text{copa}) > 0.33$.
  - Extracción de la componente conexa de área máxima (`cv2.findContours`) para eliminar islotes de falso positivo en la periferia.
  - La máscara final consolida la unión anatómica: $\text{Disco Total} = \text{Clase 1} \cup \text{Clase 2}$.

### 2.3 Cálculo del Cup-to-Disc Ratio (CDR) (`ml/inference/cdr.py`)
Existe una distinción matemática crítica entre las dos métricas analizadas:

1. **CDR para Clasificación ($\text{CDR}_{\text{área}}$):**
   $$\text{CDR}_{\text{modelo}} = \sqrt{\frac{\text{Área}(\text{Copa})}{\text{Área}(\text{Disco Total})}}$$
   *Justificación:* Esta es la fórmula exacta utilizada por `exp4_eye_level/expert_selector.py` para construir el dataset de entrenamiento de los clasificadores. Garantiza consistencia con la distribución de entrada de los modelos.
2. **CDR Vertical Clínico ($\text{CDR}_{\text{vertical}}$):**
   $$\text{CDR}_{\text{vertical}} = \frac{H_{\text{copa}}}{H_{\text{disco}}}$$
   donde $H$ corresponde a la altura del bounding box vertical de cada estructura. Se expone como métrica complementaria de interpretabilidad médica.

---

## 3. Fase 2: Clasificación Multimodal y Ensamble

### 3.1 Re-proyección y Recorte Anatómico (`create_classifier_crop`)
A diferencia de los experimentos tempranos que usaban la imagen completa reducida, el Experimento 4 demostró que recortar la región peri-papilar centrada en el disco mejora el F1-Score en más de un 30%:
1. Los puntos del contorno del disco segmentado (en escala 512×512) se mapean a coordenadas originales usando $(\text{offset}_x, \text{offset}_y)$.
2. Se calcula el tamaño de recorte adaptativo:
   $$\text{size} = \text{clip}(\max(\text{ancho}, \text{alto}) + 2 \times \text{margen}, \ 600, \ 1000)$$
   con margen $= 100\text{ px}$.
3. Se recorta la región en la imagen original y se redimensiona a **$384 \times 384$ píxeles** con interpolación de área (`cv2.INTER_AREA`).

### 3.2 Tensor de 5 Canales (`create_five_channel_image`)
Para capturar simultáneamente color, vasculatura y textura papilar:
- **Canal 0 (R):** Longitudes de onda largas, óptimas para visualizar la morfología del disco y la lámina cribosa.
- **Canal 1 (G):** Máximo contraste de absorción de hemoglobina; delinea vasos sanguíneos y bordes de la copa.
- **Canal 2 (B):** Información general de fondo.
- **Canal 3 ($R_{\text{CLAHE}}$):** Realce de contraste adaptativo sobre el canal rojo (`clipLimit=2.0`, `tileGrid=8×8`).
- **Canal 4 ($G_{\text{CLAHE}}$):** Realce de contraste adaptativo sobre el canal verde.
- El tensor resultante se normaliza a rango $[0.0, 1.0]$ dividiendo por $255.0$.

### 3.3 Normalización de Variables Clínicas (`ml/inference/classification.py`)
El modelo consume obligatoriamente 11 biomarcadores tabulares:
1. `Age` (Años)
2. `Gender` (0 = Femenino, 1 = Masculino)
3. `dioptre_1` (Esfera refractiva)
4. `dioptre_2` (Cilindro refractivo)
5. `astigmatism` (Eje astigmático)
6. `Phakic/Pseudophakic` (Estado del cristalino)
7. `Pneumatic` (Presión intraocular neumática)
8. `Perkins` (Presión intraocular de aplanación Perkins)
9. `Pachymetry` (Espesor corneal central en $\mu\text{m}$)
10. `Axial_Length` (Longitud axial ocular en mm)
11. `VF_DM` (Desviación media del campo visual en dB)

Cada variable se estandariza mediante Z-score con los parámetros de la partición Fold 4:
$$x_{\text{norm}} = \frac{x - \mu_{\text{fold4}}}{\sigma_{\text{fold4}} + 10^{-8}}$$

### 3.4 Arquitectura Multimodal (`ml/models/architecture.py`)
- **Adaptación Convolucional de Entrada:** La primera capa convolucional de los backbones estándar (`conv1` en ResNet-50, `conv_stem` en EfficientNet-B3) fue reconfigurada de 3 a 5 canales de entrada, replicando los pesos RGB promedio en los canales 3 y 4.
- **Vector de Fusión:**
  $$\vec{v}_{\text{fusión}} = [\vec{e}_{\text{visual}} \ (D_{\text{backbone}}) \ \Vert \ \text{CDR} \ (1) \ \Vert \ \vec{x}_{\text{clínico}} \ (11)]$$
- **Cabeza de Clasificación (MLP):**
  - $\text{Linear}(D + 12 \to 256) \to \text{LayerNorm} \to \text{GELU} \to \text{Dropout}(0.3)$
  - $\text{Linear}(256 \to 128) \to \text{LayerNorm} \to \text{GELU} \to \text{Dropout}(0.3)$
  - $\text{Linear}(128 \to 3)$
- **Clases de Salida:** `[0: Glaucoma, 1: Non_Glaucoma, 2: Suspicious_Glaucoma]`.

### 3.5 Ensamble de Modelos (`ml/inference/ensemble.py`)
El ensamble opera sobre las probabilidades Softmax de cada modelo individual:
$$P_{\text{ensamble}}(c) = w_{\text{eff}} \cdot P_{\text{eff}}(c) + w_{\text{res}} \cdot P_{\text{res}}(c)$$
con $w_{\text{eff}} = 0.5$ y $w_{\text{res}} = 0.5$. La clase final corresponde a $\arg\max_c P_{\text{ensamble}}(c)$.

---

## 4. Control de Calidad y Casos de Excepción

El sistema implementa compuertas de seguridad médica (`segmentation_quality`):
- Si no se detecta contorno de disco o copa.
- Si $\text{Área}(\text{Copa}) > \text{Área}(\text{Disco})$ (anatómicamente imposible).
- Si el CDR calculado es nulo o excede $[0.0, 1.0]$.
- Si la imagen no cumple la resolución mínima (512 px en el lado menor).

**Comportamiento del sistema:**  
En lugar de forzar una clasificación sobre una anatomía defectuosa, el trabajo se marca con estado **`REVIEW_REQUIRED`**, adjunta la máscara/overlay para inspección humana y devuelve probabilidades vacías.

---

## 5. Parámetros de Configuración por Defecto (`manifest.json`)

| Parámetro | Valor | Rol |
|---|---|---|
| `segmentation.image_size` | 512 | Dimensión de entrada FPN |
| `segmentation.disc_threshold` | 0.40 | Umbral de binarización de disco |
| `segmentation.cup_threshold` | 0.33 | Umbral de binarización de copa |
| `segmentation.crop_margin` | 100 | Píxeles de margen alrededor del contorno |
| `segmentation.classifier_crop_size` | 384 | Dimensión de entrada a clasificadores |
| `segmentation.classifier_crop_min` | 600 | Tamaño mínimo de recorte anatómico |
| `segmentation.classifier_crop_max` | 1000 | Tamaño máximo de recorte anatómico |
| `segmentation.clahe_clip_limit` | 2.0 | Límite de contraste local CLAHE |
| `segmentation.clahe_tile_grid` | 8 | Grilla de ecualización adaptativa |
| `ensemble.efficientnet_b3` | 0.5 | Ponderación en ensamble |
| `ensemble.resnet50` | 0.5 | Ponderación en ensamble |