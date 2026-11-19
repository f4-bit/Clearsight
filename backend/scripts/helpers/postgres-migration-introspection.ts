import type { Client } from "pg";
import {
  isPrismaHistoryShapeValid,
  type BaselineColumn,
  type BaselineConstraint,
  type BaselineEnumType,
  type BaselineIndex,
  type BaselineMetadata,
  type BaselineTable,
  type BaselineTrigger,
  type DatabaseState,
  type HistoryRow,
  type HistoryTableShape,
  type UnexpectedObject,
} from "../../src/services/migration-deployment.js";

export const PRISMA_MIGRATIONS_TABLE = "_prisma_migrations";

type ColumnRow = {
  table_name: string;
  ordinal: number;
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_expr: string | null;
  identity: string;
  generated: string;
};

type ConstraintRow = {
  table_name: string;
  name: string;
  type: string;
  columns: string[] | null;
  referenced_table: string | null;
  referenced_columns: string[] | null;
  on_update: string;
  on_delete: string;
  match_type: string;
  deferrable: boolean;
  deferred: boolean;
  definition: string | null;
};

type IndexRow = {
  table_name: string;
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  method: string;
  definition: string;
};

type TriggerRow = {
  table_name: string;
  name: string;
  enabled: string;
  definition: string;
};

type EnumRow = {
  name: string;
  labels: string[];
};

type RelationObjectRow = {
  name: string;
  relkind: string;
};

type TypeObjectRow = {
  name: string;
  typtype: string;
};

type RoutineObjectRow = {
  name: string;
  prokind: string;
};

type ExtensionObjectRow = {
  name: string;
};

type HistoryShapeRow = {
  relkind: string;
  column_name: string | null;
  data_type: string | null;
  not_null: boolean | null;
};

type HistoryRowResult = {
  migration_name: string;
  checksum: string;
  finished_at: Date | null;
  rolled_back_at: Date | null;
  applied_steps_count: number;
};

const FOREIGN_KEY_ACTIONS: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

const MATCH_TYPES: Record<string, string> = {
  s: "SIMPLE",
  f: "FULL",
  p: "PARTIAL",
};

const UNEXPECTED_RELATION_KINDS: Record<string, string> = {
  v: "view",
  m: "materialized_view",
  f: "foreign_table",
  S: "sequence",
  p: "partitioned_table",
};

const UNEXPECTED_TYPE_KINDS: Record<string, string> = {
  b: "type",
  c: "composite_type",
  d: "domain",
  r: "range",
  m: "multirange",
  p: "pseudo_type",
};

const UNEXPECTED_ROUTINE_KINDS: Record<string, string> = {
  f: "function",
  p: "procedure",
  a: "aggregate",
  w: "window_function",
};

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * Removes only a known schema qualifier from a deparsed identifier sequence.
 * String literals and double-quoted identifiers are left untouched.
 */
export function stripSchemaQualifier(value: string, schema: string): string {
  const plainToken = `${schema}.`;
  const quotedToken = `${quoteIdentifier(schema)}.`;
  let output = "";
  let index = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  while (index < value.length) {
    const character = value.charAt(index);

    if (inSingleQuote) {
      if (character === "'" && value.charAt(index + 1) === "'") {
        output += "''";
        index += 2;
        continue;
      }
      if (character === "'") {
        inSingleQuote = false;
      }
      output += character;
      index += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (character === '"' && value.charAt(index + 1) === '"') {
        output += '""';
        index += 2;
        continue;
      }
      if (character === '"') {
        inDoubleQuote = false;
      }
      output += character;
      index += 1;
      continue;
    }

    if (character === "'") {
      inSingleQuote = true;
      output += character;
      index += 1;
      continue;
    }

    if (character === '"' && value.startsWith(quotedToken, index)) {
      const previous = index > 0 ? value.charAt(index - 1) : "";
      if (!/[A-Za-z0-9_$"]/.test(previous)) {
        index += quotedToken.length;
        continue;
      }
    }

    if (character === '"') {
      inDoubleQuote = true;
      output += character;
      index += 1;
      continue;
    }

    if (value.startsWith(plainToken, index)) {
      const previous = index > 0 ? value.charAt(index - 1) : "";
      if (!/[A-Za-z0-9_$"]/.test(previous)) {
        index += plainToken.length;
        continue;
      }
    }

    output += character;
    index += 1;
  }

  return output;
}

async function readServerVersion(client: Client): Promise<number> {
  const result = await client.query<{ version: number }>(
    "SELECT pg_catalog.current_setting('server_version_num')::int AS version",
  );
  return result.rows[0]?.version ?? 0;
}

async function readUserTableNames(client: Client, schema: string): Promise<string[]> {
  const result = await client.query<{ name: string }>(
    `SELECT c.relname AS name
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relname <> $2
      ORDER BY c.relname`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );
  return result.rows.map((row) => row.name);
}

async function readColumns(client: Client, schema: string): Promise<ColumnRow[]> {
  const result = await client.query<ColumnRow>(
    `SELECT c.relname AS table_name,
            a.attnum::int AS ordinal,
            a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS default_expr,
            a.attidentity::text AS identity,
            a.attgenerated::text AS generated
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
       LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relname <> $2
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY c.relname, a.attnum`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );
  return result.rows;
}

async function readConstraints(client: Client, schema: string): Promise<ConstraintRow[]> {
  const result = await client.query<ConstraintRow>(
    `SELECT c.relname AS table_name,
            con.conname AS name,
            con.contype::text AS type,
            COALESCE((
              SELECT array_agg(attribute.attname::text ORDER BY key.ord)
                FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid = con.conrelid
                 AND attribute.attnum = key.attnum
            ), ARRAY[]::text[]) AS columns,
            ref.relname AS referenced_table,
            COALESCE((
              SELECT array_agg(attribute.attname::text ORDER BY key.ord)
                FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid = con.confrelid
                 AND attribute.attnum = key.attnum
            ), ARRAY[]::text[]) AS referenced_columns,
            con.confupdtype::text AS on_update,
            con.confdeltype::text AS on_delete,
            con.confmatchtype::text AS match_type,
            con.condeferrable AS deferrable,
            con.condeferred AS deferred,
            CASE WHEN con.contype = 'c'
                 THEN pg_catalog.pg_get_constraintdef(con.oid, false)
                 ELSE NULL
            END AS definition
       FROM pg_catalog.pg_constraint con
       JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_class ref ON ref.oid = con.confrelid
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relname <> $2
      ORDER BY c.relname, con.conname`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );
  return result.rows;
}

async function readIndexes(client: Client, schema: string): Promise<IndexRow[]> {
  const result = await client.query<IndexRow>(
    `SELECT c.relname AS table_name,
            index_class.relname AS name,
            idx.indisunique AS is_unique,
            idx.indisprimary AS is_primary,
            access_method.amname AS method,
            pg_catalog.pg_get_indexdef(idx.indexrelid, 0, false) AS definition
       FROM pg_catalog.pg_index idx
       JOIN pg_catalog.pg_class index_class ON index_class.oid = idx.indexrelid
       JOIN pg_catalog.pg_class c ON c.oid = idx.indrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_catalog.pg_am access_method ON access_method.oid = index_class.relam
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'p')
        AND c.relname <> $2
      ORDER BY c.relname, index_class.relname`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );
  return result.rows;
}

async function readTriggers(client: Client, schema: string): Promise<TriggerRow[]> {
  const result = await client.query<TriggerRow>(
    `SELECT c.relname AS table_name,
            trg.tgname AS name,
            trg.tgenabled::text AS enabled,
            pg_catalog.pg_get_triggerdef(trg.oid, false) AS definition
       FROM pg_catalog.pg_trigger trg
       JOIN pg_catalog.pg_class c ON c.oid = trg.tgrelid
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND NOT trg.tgisinternal
        AND c.relname <> $2
      ORDER BY c.relname, trg.tgname`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );
  return result.rows;
}

async function readEnums(client: Client, schema: string): Promise<BaselineEnumType[]> {
  const result = await client.query<EnumRow>(
    `SELECT pg_type.typname AS name,
            COALESCE(array_agg(enum_value.enumlabel ORDER BY enum_value.enumsortorder), ARRAY[]::text[]) AS labels
       FROM pg_catalog.pg_type
       JOIN pg_catalog.pg_namespace n ON n.oid = pg_type.typnamespace
       LEFT JOIN pg_catalog.pg_enum enum_value ON enum_value.enumtypid = pg_type.oid
      WHERE n.nspname = $1
        AND pg_type.typtype = 'e'
      GROUP BY pg_type.typname
      ORDER BY pg_type.typname`,
    [schema],
  );
  return result.rows.map((row) => ({ name: row.name, labels: row.labels }));
}

async function readUnexpectedRelations(
  client: Client,
  schema: string,
): Promise<UnexpectedObject[]> {
  const result = await client.query<RelationObjectRow>(
    `SELECT c.relname AS name,
            c.relkind::text AS relkind
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relname <> $2
        AND c.relkind NOT IN ('r', 'i', 'I', 't', 'c')
      ORDER BY c.relname, c.relkind`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );

  return result.rows.map((row) => ({
    kind: UNEXPECTED_RELATION_KINDS[row.relkind] ?? `relation_${row.relkind}`,
    name: row.name,
  }));
}

async function readUnexpectedTypes(client: Client, schema: string): Promise<UnexpectedObject[]> {
  const result = await client.query<TypeObjectRow>(
    `SELECT pg_type.typname AS name,
            pg_type.typtype::text AS typtype
       FROM pg_catalog.pg_type
       JOIN pg_catalog.pg_namespace n ON n.oid = pg_type.typnamespace
      WHERE n.nspname = $1
        AND pg_type.typtype <> 'e'
        AND NOT (
          pg_type.typtype = 'b'
          AND pg_type.typelem <> 0
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_type element
             WHERE element.oid = pg_type.typelem
               AND element.typarray = pg_type.oid
          )
        )
        AND NOT (
          pg_type.typrelid <> 0
          AND EXISTS (
            SELECT 1
              FROM pg_catalog.pg_class c
             WHERE c.oid = pg_type.typrelid
               AND c.relkind IN ('r', 'p')
          )
        )
      ORDER BY pg_type.typname, pg_type.typtype`,
    [schema],
  );

  return result.rows.map((row) => ({
    kind: UNEXPECTED_TYPE_KINDS[row.typtype] ?? `type_${row.typtype}`,
    name: row.name,
  }));
}

async function readUnexpectedRoutines(
  client: Client,
  schema: string,
): Promise<UnexpectedObject[]> {
  const result = await client.query<RoutineObjectRow>(
    `SELECT routine.proname AS name,
            routine.prokind::text AS prokind
       FROM pg_catalog.pg_proc routine
       JOIN pg_catalog.pg_namespace n ON n.oid = routine.pronamespace
      WHERE n.nspname = $1
      ORDER BY routine.proname, routine.oid`,
    [schema],
  );

  return result.rows.map((row) => ({
    kind: UNEXPECTED_ROUTINE_KINDS[row.prokind] ?? `routine_${row.prokind}`,
    name: row.name,
  }));
}

async function readUnexpectedExtensions(
  client: Client,
  schema: string,
): Promise<UnexpectedObject[]> {
  const result = await client.query<ExtensionObjectRow>(
    `SELECT extension.extname AS name
       FROM pg_catalog.pg_extension extension
       JOIN pg_catalog.pg_namespace n ON n.oid = extension.extnamespace
      WHERE n.nspname = $1
      ORDER BY extension.extname`,
    [schema],
  );

  return result.rows.map((row) => ({ kind: "extension", name: row.name }));
}

async function readUnexpectedObjects(
  client: Client,
  schema: string,
): Promise<UnexpectedObject[]> {
  const relations = await readUnexpectedRelations(client, schema);
  const types = await readUnexpectedTypes(client, schema);
  const routines = await readUnexpectedRoutines(client, schema);
  const extensions = await readUnexpectedExtensions(client, schema);

  const objects = [...relations, ...types, ...routines, ...extensions];
  return objects.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind < right.kind ? -1 : 1;
    }
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
  });
}

function toColumn(row: ColumnRow, schema: string): BaselineColumn {
  return {
    ordinal: row.ordinal,
    name: row.column_name,
    type: row.data_type,
    nullable: !row.not_null,
    default: row.default_expr === null ? null : stripSchemaQualifier(row.default_expr, schema),
    identity: row.identity,
    generated: row.generated,
  };
}

function toConstraint(row: ConstraintRow, schema: string): BaselineConstraint {
  const isForeignKey = row.type === "f";
  return {
    type: row.type,
    name: row.name,
    columns: row.columns ?? [],
    referencedTable: isForeignKey ? row.referenced_table : null,
    referencedColumns: isForeignKey ? (row.referenced_columns ?? []) : [],
    onUpdate: isForeignKey ? (FOREIGN_KEY_ACTIONS[row.on_update] ?? row.on_update) : null,
    onDelete: isForeignKey ? (FOREIGN_KEY_ACTIONS[row.on_delete] ?? row.on_delete) : null,
    matchType: isForeignKey ? (MATCH_TYPES[row.match_type] ?? row.match_type) : null,
    deferrable: row.deferrable,
    deferred: row.deferred,
    definition: row.definition === null ? null : stripSchemaQualifier(row.definition, schema),
  };
}

function toIndex(row: IndexRow, schema: string): BaselineIndex {
  return {
    name: row.name,
    unique: row.is_unique,
    primary: row.is_primary,
    method: row.method,
    definition: stripSchemaQualifier(row.definition, schema),
  };
}

function toTrigger(row: TriggerRow, schema: string): BaselineTrigger {
  return {
    name: row.name,
    enabled: row.enabled,
    definition: stripSchemaQualifier(row.definition, schema),
  };
}

async function readBaselineMetadata(client: Client, schema: string): Promise<BaselineMetadata> {
  // pg clients are not concurrent: run catalog reads sequentially.
  const names = await readUserTableNames(client, schema);
  const columns = await readColumns(client, schema);
  const constraints = await readConstraints(client, schema);
  const indexes = await readIndexes(client, schema);
  const triggers = await readTriggers(client, schema);
  const enums = await readEnums(client, schema);
  const unexpectedObjects = await readUnexpectedObjects(client, schema);

  const tables: BaselineTable[] = names.map((name) => ({
    name,
    columns: columns.filter((row) => row.table_name === name).map((row) => toColumn(row, schema)),
    constraints: constraints
      .filter((row) => row.table_name === name)
      .map((row) => toConstraint(row, schema)),
    indexes: indexes.filter((row) => row.table_name === name).map((row) => toIndex(row, schema)),
    triggers: triggers.filter((row) => row.table_name === name).map((row) => toTrigger(row, schema)),
  }));

  return { tables, enums, unexpectedObjects };
}

async function readHistoryTableShape(client: Client, schema: string): Promise<HistoryTableShape> {
  const result = await client.query<HistoryShapeRow>(
    `SELECT c.relkind::text AS relkind,
            a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_catalog.pg_attribute a
         ON a.attrelid = c.oid
        AND a.attnum > 0
        AND NOT a.attisdropped
      WHERE n.nspname = $1
        AND c.relname = $2
      ORDER BY a.attnum`,
    [schema, PRISMA_MIGRATIONS_TABLE],
  );

  if (result.rows.length === 0) {
    return { exists: false, isTable: false, columns: [] };
  }

  const first = result.rows[0];
  if (first === undefined) {
    return { exists: false, isTable: false, columns: [] };
  }

  return {
    exists: true,
    isTable: first.relkind === "r",
    columns: result.rows
      .filter(
        (row): row is HistoryShapeRow & { column_name: string; data_type: string; not_null: boolean } =>
          row.column_name !== null && row.data_type !== null && row.not_null !== null,
      )
      .map((row) => ({ name: row.column_name, type: row.data_type, nullable: !row.not_null })),
  };
}

async function readHistoryRows(client: Client, schema: string): Promise<HistoryRow[]> {
  const result = await client.query<HistoryRowResult>(
    `SELECT migration_name,
            checksum,
            finished_at,
            rolled_back_at,
            applied_steps_count
       FROM ${quoteIdentifier(schema)}.${quoteIdentifier(PRISMA_MIGRATIONS_TABLE)}
      ORDER BY migration_name`,
  );

  return result.rows.map((row) => ({
    migrationName: row.migration_name,
    checksum: row.checksum,
    finishedAt: row.finished_at,
    rolledBackAt: row.rolled_back_at,
    appliedStepsCount: row.applied_steps_count,
  }));
}

/**
 * Read-only introspection. The caller owns the transaction and must close it
 * before invoking the Prisma CLI.
 */
export async function inspectDatabase(client: Client, schema: string): Promise<DatabaseState> {
  // pg clients are not concurrent: run catalog reads sequentially.
  const serverVersionNum = await readServerVersion(client);
  const userTables = await readUserTableNames(client, schema);
  const metadata = await readBaselineMetadata(client, schema);
  const historyTable = await readHistoryTableShape(client, schema);

  const historyRows = isPrismaHistoryShapeValid(historyTable)
    ? await readHistoryRows(client, schema)
    : [];

  return {
    serverVersionNum,
    userTables,
    metadata,
    historyTable,
    historyRows,
  };
}
