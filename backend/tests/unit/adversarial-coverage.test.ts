import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalClassIndex } from "../../src/schemas/common.js";
import { parseIdempotencyKey } from "../../src/services/idempotency.js";
import {
  resolveStorageProviderConfig,
  StorageProviderError,
} from "../../src/services/storage-provider.js";

/**
 * Lightweight adversarial coverage index. It deliberately does not duplicate
 * the DB, network or SDK suites; it asserts the existing adversarial contracts
 * are present and keeps the pure boundary behavior executable.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

function expectCanaries(relativePath: string, canaries: readonly string[]): void {
  const content = read(relativePath);
  for (const canary of canaries) {
    expect(content, `${relativePath} must cover ${canary}`).toContain(canary);
  }
}

describe("adversarial coverage index", () => {
  it("keeps the ML URL policy adversarial cases covered", () => {
    expectCanaries("ml/tests/test_service_contract.py", [
      "redirect",
      "image_url_host_not_allowed",
      "image_url_host_allowlist_required",
      "image_download_failed",
    ]);
  });

  it("keeps idempotency, worker duplicate/CAS and storage/audit cases covered", () => {
    expectCanaries("backend/tests/unit/idempotency.test.ts", [
      "strict stored 202 replay",
      "parseIdempotencyKey",
    ]);
    expectCanaries(
      "backend/tests/inference-idempotency.integration.test.ts",
      ["replays the same strict 202"],
    );
    expectCanaries("backend/tests/unit/inference.processor.test.ts", [
      "duplicate terminal job",
      "saveTerminalResult",
      "rejects unknown labels",
    ]);
    expectCanaries("backend/tests/artifact-downloads.integration.test.ts", [
      "storage_object_missing",
      "409",
    ]);
    expectCanaries("backend/tests/unit/audit.test.ts", [
      "aborts",
      "AUDIT_STORE_UNAVAILABLE",
    ]);
    expectCanaries("backend/tests/unit/storage-provider.test.ts", [
      "storage_invalid_provider",
    ]);
  });

  it("keeps unknown labels and prototype keys fail-closed", () => {
    expect(canonicalClassIndex("Glaucoma")).toBe(0);
    expect(canonicalClassIndex("unknown_label")).toBeNull();
    expect(canonicalClassIndex("__proto__")).toBeNull();
    expect(canonicalClassIndex("constructor")).toBeNull();
    expect(canonicalClassIndex("toString")).toBeNull();
  });

  it("rejects an unknown storage provider without fallback", () => {
    let error: unknown;
    try {
      resolveStorageProviderConfig({
        STORAGE_PROVIDER: "unknown",
      } as never);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StorageProviderError);
    expect(error).toMatchObject({ code: "storage_invalid_provider" });
  });

  it("keeps idempotency keys strict and single-valued", () => {
    expect(() => parseIdempotencyKey("valid-key_1")).not.toThrow();
    for (const invalid of [undefined, "", " ", "a,b", "a b", "x".repeat(129)]) {
      expect(() => parseIdempotencyKey(invalid)).toThrow();
    }
  });

  it("keeps missing-object storage errors distinguishable for the 409 path", () => {
    expect(new StorageProviderError("storage_object_missing")).toMatchObject({
      code: "storage_object_missing",
    });
  });
});
