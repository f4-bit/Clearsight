export const DEFAULT_DATABASE_SCHEMA = "public";

const POSTGRES_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_POSTGRES_IDENTIFIER_BYTES = 63;
const INVALID_DATABASE_SCHEMA_MESSAGE = "databaseSchema must be a valid PostgreSQL identifier";

/**
 * Validates a schema name before it is embedded in a qualified raw query.
 * Only ASCII PostgreSQL identifiers of at most 63 bytes are accepted, which
 * excludes NUL, quotes, semicolons and other injection/truncation cases.
 */
export function assertValidDatabaseSchema(schema: string): void {
  if (
    typeof schema !== "string" ||
    schema.length === 0 ||
    Buffer.byteLength(schema, "utf8") > MAX_POSTGRES_IDENTIFIER_BYTES ||
    !POSTGRES_IDENTIFIER_PATTERN.test(schema)
  ) {
    throw new Error(INVALID_DATABASE_SCHEMA_MESSAGE);
  }
}
