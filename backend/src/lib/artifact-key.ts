/**
 * Pure object-key policy shared by reference parsing and the ArtifactRef DTO.
 * No SDK, environment, filesystem or network access belongs here.
 *
 * A key is exact text. Only the beginning may not look like a URI scheme
 * (`blob:`, `file:`, `data:`, `s3:`, ...), because top-level legacy
 * `s3://`/`azure://` references are parsed before this policy runs. Embedded
 * text such as `folder/http://literal.bin` remains a valid key.
 */
const URI_SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const SIGNATURE = /(^|[?&])(sig|x-amz-signature|x-amz-credential|x-amz-security-token)=/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function isValidArtifactKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.trim().length === 0) {
    return false;
  }
  if (CONTROL_CHARS.test(key)) {
    return false;
  }
  if (key.split("/").some((segment) => segment === "." || segment === "..")) {
    return false;
  }
  if (URI_SCHEME_PREFIX.test(key) || SIGNATURE.test(key)) {
    return false;
  }
  return true;
}
