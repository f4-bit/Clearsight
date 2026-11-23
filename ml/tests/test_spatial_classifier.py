import numpy as np
import onnxruntime as ort
import pytest
import torch

from ml.inference.spatial_classifier import SpatialClassifier
from ml.models.architecture import create_model
from scripts.export_onnx import _convert_to_fp16


@pytest.mark.parametrize("architecture", ["resnet50", "efficientnet_b3"])
def test_class_maps_match_autograd_and_export(architecture, tmp_path):
    # Fixed inputs and untrained weights exercise the deployed architecture,
    # without downloading any trained checkpoint or clinical image.
    torch.manual_seed(29)
    model = create_model(architecture).eval()
    inputs = (torch.rand(2, 5, 64, 64), torch.rand(2, 1), torch.rand(2, 11))
    with torch.no_grad():
        spatial = model.backbone.forward_features(inputs[0])
        deployed_logits = model(*inputs)
        exported = SpatialClassifier(model).eval()
        logits, actual = exported(*inputs)
    torch.testing.assert_close(logits, deployed_logits)
    spatial.requires_grad_()
    visual = model.backbone.forward_head(spatial)
    probs = model.classifier(torch.cat((visual, *inputs[1:]), 1)).softmax(dim=1)
    for k in range(model.num_classes):
        grad, = torch.autograd.grad(probs[:, k].sum(), spatial, retain_graph=True)
        reference = (grad.mean(dim=(2, 3), keepdim=True) * spatial).sum(dim=1)
        torch.testing.assert_close(actual[:, k], reference, atol=1e-6, rtol=1e-4)

    path = tmp_path / "classifier.onnx"
    names = ["image", "cdr", "clinical"]
    outputs = ["logits", "class_activation_maps"]
    torch.onnx.export(exported, tuple(x[:1] for x in inputs), str(path), opset_version=17,
                      dynamo=False, input_names=names, output_names=outputs,
                      dynamic_axes={name: {0: "batch"} for name in names + outputs})
    session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    ort_logits, ort_maps = session.run(None, dict(zip(names, (x.numpy() for x in inputs))))
    np.testing.assert_allclose(ort_logits, logits.numpy(), atol=2e-5, rtol=1e-4)
    np.testing.assert_allclose(ort_maps, actual.numpy(), atol=1e-6, rtol=1e-4)
    del session
    _convert_to_fp16(path)
    half = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    half_logits, half_maps = half.run(None, dict(zip(names, (x.numpy() for x in inputs))))
    np.testing.assert_allclose(half_logits, logits.numpy(), atol=0.01, rtol=0.01)
    np.testing.assert_allclose(half_maps, actual.numpy(), atol=2e-4, rtol=0.02)
