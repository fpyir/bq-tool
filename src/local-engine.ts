import { DuckDBInstance, StatementType, DuckDBTypeId, DuckDBListType, DuckDBStructType, DuckDBMapType } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBType } from "@duckdb/node-api";
import type { Field, Row } from "./bigquery.ts";
import { identifier, localType } from "./duckdb.ts";
import { ToolError } from "./contracts.ts";
import { inspectLocalQuery } from "./local-policy.ts";
import type { z } from "zod";
import { localSchema, rowsSchema } from "./local-contracts.ts";

export const MEMORY_BYTES = 268_435_456;
export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;
export type LocalRows = z.infer<typeof rowsSchema>;
export function preview(rows: LocalRows) {
  const small: LocalRows = [];
  let bytes = 0;
  for (const row of rows.slice(0, 10)) {
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 65_536) break;
    small.push(row);
  }
  return { rows: small, complete: small.length === rows.length };
}

export async function withEngine<T>(paths: string[], timeoutMs: number, action: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
  const instance = await DuckDBInstance.create(":memory:", {
    temp_directory: "", max_temp_directory_size: "0B",
    autoinstall_known_extensions: "false", autoload_known_extensions: "false", allow_community_extensions: "false",
    memory_limit: `${MEMORY_BYTES}B`, threads: "2",
  });
  let connection: DuckDBConnection | undefined;
  let timedOut = false;
  let deadline = Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    connection = await instance.connect();
    await connection.run(`SET allowed_paths = [${paths.map(literal).join(",")}]`);
    await connection.run("SET enable_external_access = false");
    await connection.run("SET TimeZone = 'UTC'");
    await connection.run("SET lock_configuration = true");
    deadline = Date.now() + timeoutMs;
    timer = setTimeout(() => { timedOut = true; connection?.interrupt(); }, timeoutMs);
    const result = await action(connection);
    if (timedOut || Date.now() > deadline) throw new ToolError("LOCAL_TIMEOUT", "Local execution timed out");
    return result;
  } catch (error) {
    if (timedOut) throw new ToolError("LOCAL_TIMEOUT", "Local execution timed out");
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    connection?.closeSync();
    instance.closeSync();
  }
}

export async function importRows(connection: DuckDBConnection, fields: Field[], rows: Row[]) {
  if (!fields.length || new Set(fields.map((field) => field.name.toLowerCase())).size !== fields.length) {
    throw new ToolError("LOCAL_SCHEMA", "Saved results need nonempty, case-insensitively unique column names");
  }
  await connection.run(`CREATE TABLE output (${fields.map((field) => `${identifier(field.name)} ${localType(field)}`).join(", ")})`);
  const batchSize = Math.max(1, Math.min(100, Math.floor(10_000 / fields.length)));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const values: (string | boolean | null)[] = [];
    const expressions = rows.slice(offset, offset + batchSize).map((row) => `(${fields.map((field) => {
      const value = row[field.name];
      if (value === undefined) throw new ToolError("LOCAL_SCHEMA", `Missing field ${field.name}`);
      values.push(value !== null && typeof value === "object" ? JSON.stringify(value) : value);
      const parameter = `$${values.length}`;
      const expression = field.mode === "REPEATED" || field.type === "RECORD" ? `CAST(${parameter} AS JSON)` : parameter;
      return `CAST(${expression} AS ${localType(field)})`;
    }).join(",")})`);
    await connection.run(`INSERT INTO output VALUES ${expressions.join(",")}`, values);
  }
}

export async function evaluate(connection: DuckDBConnection, sql: string, inputs: { alias: string; path: string }[], maxRows: number) {
  if (new Set(inputs.map((input) => input.alias.toLowerCase())).size !== inputs.length || inputs.some((input) => input.alias.toLowerCase() === "output")) {
    throw new ToolError("LOCAL_SQL", "Input aliases must be unique; output is reserved");
  }
  for (const input of inputs) await connection.run(`CREATE VIEW ${identifier(input.alias)} AS SELECT * FROM read_parquet(${literal(input.path)})`);
  await inspectLocalQuery(connection, sql, inputs.map((input) => input.alias));
  const statements = await connection.extractStatements(sql);
  if (statements.count !== 1) throw new ToolError("LOCAL_SQL", "Expected one SELECT statement");
  const prepared = await statements.prepare(0);
  try {
    if (prepared.statementType !== StatementType.SELECT) throw new ToolError("LOCAL_SQL", "Expected a SELECT statement");
    const names = Array.from({ length: prepared.columnCount }, (_, index) => prepared.columnName(index));
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new ToolError("LOCAL_SCHEMA", "Give each output column a unique alias");
  } finally { prepared.destroySync(); }
  // Parse again inside a subquery to preserve SELECT semantics; the outer cap detects overflow, never silently truncates.
  await connection.run(`CREATE TABLE output AS SELECT * FROM (${sql.replace(/;\s*$/, "")}) AS bounded_result LIMIT ${maxRows + 1}`);
}

export async function readOutput(connection: DuckDBConnection, maxRows: number, maxBytes: number) {
  const result = await connection.stream("SELECT * FROM output");
  try {
    const schema = localSchema.parse(result.columnNames().map((name, index) => ({ name, type: String(result.columnType(index)) })));
    const rows: LocalRows = [];
    let bytes = Buffer.byteLength(JSON.stringify(schema));
    for await (const values of result.yieldRowObjectJson()) {
      for (const row of values) {
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length >= maxRows || bytes > maxBytes) throw new ToolError("LOCAL_RESULT_LIMIT", "Local result exceeds configured row/byte limits; no result was published");
        rows.push(row);
      }
    }
    if (bytes > maxBytes) throw new ToolError("LOCAL_RESULT_LIMIT", "Local schema exceeds the result byte limit");
    return { schema, rows };
  } finally { result.closeSync(); }
}

export async function writeParquet(connection: DuckDBConnection, destination: string) {
  await connection.run(`COPY output TO ${literal(destination)} (FORMAT PARQUET, COMPRESSION ZSTD)`);
}

function parquetType(type: DuckDBType): string {
  if (type.typeId === DuckDBTypeId.HUGEINT || type.typeId === DuckDBTypeId.UHUGEINT) return "DECIMAL(38,0)";
  if (type instanceof DuckDBListType) return `${parquetType(type.valueType)}[]`;
  if (type instanceof DuckDBStructType && !type.isTuple) return `STRUCT(${type.entryNames.map((name, index) => `${identifier(name)} ${parquetType(type.entryTypes[index]!)}`).join(",")})`;
  if (type instanceof DuckDBMapType) return `MAP(${parquetType(type.keyType)}, ${parquetType(type.valueType)})`;
  const supported = ["BOOLEAN", "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "FLOAT", "DOUBLE", "VARCHAR", "BLOB", "DECIMAL", "TIMESTAMP", "TIMESTAMP_TZ", "DATE", "TIME"];
  if (!supported.some((name) => DuckDBTypeId[type.typeId] === name)) throw new ToolError("LOCAL_TYPE", `Unsupported saved Parquet type: ${type}`);
  return String(type);
}

export async function normalizeParquetTypes(connection: DuckDBConnection) {
  const result = await connection.runAndReadAll("SELECT * FROM output LIMIT 0");
  const columns = result.columnNames().map((name, index) => ({ name, original: String(result.columnType(index)), target: parquetType(result.columnType(index)) }));
  result.closeSync();
  for (const column of columns) if (column.original !== column.target) await connection.run(`ALTER TABLE output ALTER COLUMN ${identifier(column.name)} TYPE ${column.target}`);
}
