# ML Serving Optimization — Initial Capability

> Capacidad inicial del repo registrada como `ADDED`. No existe baseline versionada de esta capacidad; el contenido es autosuficiente para un clon limpio.

## ADDED Requirements

### Requirement: Poblamiento de normalización clínica Z-score

The system SHALL populate `clinical_mean` and `clinical_std` in `ml/models/manifest.json` and document them in `.env.example` with the 11 biometric floats in strict order of `clinical_features`, enabling unblocked runtime initialization without RuntimeError.

#### Scenario: Runtime initialization with clinical parameters

- **WHEN** `ClassificationRunner` is initialized with the populated manifest
- **THEN** it succeeds without throwing `RuntimeError` and correctly computes Z-scores in `_clinical_vector`.

### Requirement: Generador de explicabilidad Grad-CAM

The system SHALL retain Grad-CAM as an SRS requirement and deliver it as a separate, deferred deliverable after the priority backend/ML/Azure/security/PDF milestone. Until that deliverable is implemented and verified, the system MUST report the `gradcam` artifact as `NOT_SUPPORTED` (or `NOT_REQUESTED` when not requested), MUST NOT expose it as available, and MUST NOT simulate heatmaps or overlays. When delivered, it SHALL implement `ml/inference/gradcam.py` providing Grad-CAM saliency heatmaps for classification models (ResNet-50 and EfficientNet-B3) targeting feature extraction convolutional layers and producing PNG overlay bytes. The artifact MUST use the common structured reference and authorization contract, and MUST NOT be confused with the segmentation overlay.

#### Scenario: Grad-CAM not yet delivered

- **WHEN** a client requests Grad-CAM before the deferred deliverable exists
- **THEN** the system reports the artifact as `NOT_SUPPORTED`
- **AND** returns no URL, no fake heatmap and no simulated overlay.

#### Scenario: Saliency map generation for optic disc

- **WHEN** the deferred Grad-CAM deliverable is implemented and invoked with a cropped retinal image tensor and target class
- **THEN** it generates a 2D normalized heatmap [0, 1] and an overlay image encoded as PNG bytes
- **AND** publishes it as a distinct `gradcam` artifact through the authorized reference flow.

### Requirement: Exportador ONNX FP16 y runner ONNX Runtime

The system SHALL provide `scripts/export_onnx.py` to export trained PyTorch multimodal classification models to ONNX FP16 and `ml/inference/onnx_serving.py` with `OnnxClassificationRunner` matching the `ClassificationRunner.predict` contract.

#### Scenario: ONNX classification inference

- **WHEN** `OnnxClassificationRunner.predict` is invoked with test image and clinical features
- **THEN** it returns a dictionary with predictions whose probability distributions match the expected class names.

### Requirement: Benchmark de latencia y suite de pruebas

The system SHALL provide `scripts/benchmark_latency.py` comparing PyTorch eager execution against ONNX Runtime, and unit tests in `ml/tests/` covering clinical manifest validation, Grad-CAM generation, and ONNX serving.

#### Scenario: Test suite execution

- **WHEN** pytest is executed across the new test modules
- **THEN** all tests pass validating numerical and shape contracts.
