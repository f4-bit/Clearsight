/**
 * Shared password-hashing policy for every current writer (bootstrap, seed and
 * future administrative provisioning).
 *
 * Legacy hashes created with lower costs (for example the old cost 10) remain
 * valid for login: they cannot be re-hashed without the plaintext, and this
 * module deliberately does not attempt offline conversion. Rate limiting and
 * password upgrades remain pending work (5.3 and later).
 */
export const PASSWORD_BCRYPT_COST = 12;

/**
 * Public synthetic canary used only to validate the precomputed dummy hash in
 * tests. It is not a credential for any account.
 */
export const PASSWORD_DUMMY_CANARY = "clearsight-dummy-login-password";

/**
 * Precomputed bcrypt hash of `PASSWORD_DUMMY_CANARY` at
 * `PASSWORD_BCRYPT_COST`. Unknown-account logins compare against this value so
 * they do comparable work without hashing at startup or opening a network path.
 */
export const PASSWORD_DUMMY_HASH =
  "$2b$12$z841GmjnhygCe/.sw6Z2leXhymrhp1dT74aEeZaFUuLK4IeA5Ancy";
