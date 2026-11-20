import { afterEach, describe, expect, it, vi } from "vitest";
import { FEATURES } from "../fixtures/clinical.js";
import { makePreparedSnapshot } from "../helpers/ml.js";
import {
  MlClient,
  MlClientError,
  MlClientHttpError,
} from "../../src/services/ml-client.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MlClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prepares with injected URL/token and returns the parsed wire payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(makePreparedSnapshot(FEATURES)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new MlClient({
      baseUrl: "https://ml.test/",
      apiToken: "service-secret",
      timeoutMs: 1_000,
    });

    const result = await client.prepareClinicalSnapshot({
      clinical_features: FEATURES,
      requested_model_version: null,
    });

    expect(result).toMatchObject({ schemaVersion: "ml-zscore-f32-v1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://ml.test/v1/clinical-snapshots/prepare");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer service-secret",
      },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      clinical_features: FEATURES,
      requested_model_version: null,
    });
  });

  it("maps upstream 422 and 404 to status-bearing safe errors", async () => {
    for (const status of [422, 404, 503]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
        new Response("upstream secret body", { status }),
      ));
      const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

      await expect(
        client.prepareClinicalSnapshot({
          clinical_features: FEATURES,
          requested_model_version: null,
        }),
      ).rejects.toMatchObject({ status });
    }
  });

  it("does not expose upstream text or leak invalid JSON details", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("sensitive upstream response", { status: 500 }),
    ));
    const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

    const error = await client
      .prepareClinicalSnapshot({
        clinical_features: FEATURES,
        requested_model_version: null,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MlClientHttpError);
    expect(String(error)).not.toContain("sensitive upstream response");
  });

  it("maps network failures and invalid JSON to MlClientError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

    await expect(
      client.prepareClinicalSnapshot({
        clinical_features: FEATURES,
        requested_model_version: null,
      }),
    ).rejects.toBeInstanceOf(MlClientError);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", { status: 200 })));
    await expect(
      client.prepareClinicalSnapshot({
        clinical_features: FEATURES,
        requested_model_version: null,
      }),
    ).rejects.toBeInstanceOf(MlClientError);
  });

  it("accepts the pinned payload shape for the future worker", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ inference_id: crypto.randomUUID(), job_id: crypto.randomUUID(), status: "QUEUED" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

    await client.submitInference({
      inference_id: crypto.randomUUID(),
      image_url: "https://ml.test/image.png",
      eye_side: "OD",
      clinical_features: FEATURES,
      model_version: "2026-09-24",
      expected_context: {
        schema_version: "ml-zscore-f32-v1",
        fingerprint_sha256: "a".repeat(64),
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body));
    expect(body.expected_context).toEqual({
      schema_version: "ml-zscore-f32-v1",
      fingerprint_sha256: "a".repeat(64),
    });
  });

  it("strictly parses and maps the snake_case job status wire", async () => {
    const inferenceId = crypto.randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          inference_id: inferenceId,
          job_id: inferenceId,
          status: "COMPLETED",
          stage: "COMPLETED",
          message: null,
          result: {
            inference_id: inferenceId,
            eye_side: "OD",
            label: "Glaucoma",
            confidence: 0.8,
            probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
            model_predictions: {
              resnet50: {
                probabilities: { Glaucoma: 0.8, Non_Glaucoma: 0.2 },
                predicted_class: "Glaucoma",
                confidence: 0.8,
              },
            },
            cdr: 0.4,
            cdr_vertical: 0.45,
            quality: { review_required: false },
            artifacts: { mask: "s3://masks/mask.png" },
            model_versions: { resnet50: "repo@revision" },
            elapsed_seconds: 1.2,
          },
        }),
      ),
    );
    const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

    const status = await client.getJobStatus(inferenceId);

    expect(status).toMatchObject({
      inferenceId,
      status: "COMPLETED",
      result: {
        inferenceId,
        eyeSide: "OD",
        label: "Glaucoma",
        modelPredictions: {
          resnet50: {
            predictedClass: "Glaucoma",
            confidence: 0.8,
          },
        },
        modelVersions: { resnet50: "repo@revision" },
      },
    });
  });

  it("rejects an invalid status/result wire without exposing its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          inference_id: crypto.randomUUID(),
          job_id: crypto.randomUUID(),
          status: "NOT_A_STATUS",
          stage: "X",
          result: null,
        }),
      ),
    );
    const client = new MlClient({ baseUrl: "https://ml.test", apiToken: null });

    await expect(client.getJobStatus(crypto.randomUUID())).rejects.toBeInstanceOf(
      MlClientError,
    );
  });
});
