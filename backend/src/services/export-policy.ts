/**
 * Gold-standard export pseudonymization policy.
 *
 * HMAC is pseudonymization, never anonymization. A production deployment must
 * provide an explicit high-entropy secret; known development placeholders and
 * secrets shorter than 32 characters are rejected fail-closed at the config,
 * HTTP app and offline CLI boundaries.
 */
export const KNOWN_DEV_EXPORT_HMAC_SECRET =
  "clearsight-dev-export-hmac-change-in-prod";

export const MIN_EXPORT_HMAC_SECRET_LENGTH = 32;

const PLACEHOLDER_PATTERN = /replace[_-]?me|change[_-]?in[_-]?prod/i;

export function assertProductionExportHmacSecret(
  secret: unknown,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv !== "production") {
    return;
  }
  if (
    typeof secret !== "string" ||
    secret.length < MIN_EXPORT_HMAC_SECRET_LENGTH ||
    secret === KNOWN_DEV_EXPORT_HMAC_SECRET ||
    PLACEHOLDER_PATTERN.test(secret)
  ) {
    throw new Error(
      "EXPORT_HMAC_SECRET must be an explicit secret of at least 32 characters in production",
    );
  }
}
