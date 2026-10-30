import { DuckDBInstance } from "@duckdb/node-api";
import type { Field, Row } from "./bigquery.ts";
import { PROBE_CHECK_SQL } from "./probe-sql.ts";

function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function localType(field: Field): string {
  if (field.mode === "REPEATED") return `${localType({ ...field, mode: "NULLABLE" })}[]`;
  if (field.type === "RECORD") {
    if (!field.fields?.length) throw new Error("Cannot transfer an empty RECORD");
    return `STRUCT(${field.fields.map((child) => `${identifier(child.name)} ${localType(child)}`).join(", ")})`;
  }
  const types: Record<string, string> = {
    INTEGER: "BIGINT",
    NUMERIC: "DECIMAL(38,9)",
    // DuckDB DECIMAL supports up to 38 digits. Preserve BIGNUMERIC as exact text.
    BIGNUMERIC: "VARCHAR",
    FLOAT: "DOUBLE",
    BOOLEAN: "BOOLEAN",
    STRING: "VARCHAR",
    TIMESTAMP: "TIMESTAMPTZ",
    DATE: "DATE",
    DATETIME: "TIMESTAMP",
    TIME: "TIME",
    JSON: "JSON",
  };
  const type = types[field.type];
  if (!type) throw new Error(`Unsupported BigQuery type in prototype transfer: ${field.type}`);
  return type;
}

export async function checkRuntime() {
  const instance = await DuckDBInstance.create(":memory:", { enable_external_access: "false" });
  try {
    const connection = await instance.connect();
    try {
      const result = await connection.runAndReadAll("SELECT version() AS version, 1 + 1 AS answer");
      const [row] = result.getRowObjectsJson();
      if (!row || row.answer !== 2) throw new Error("DuckDB runtime check failed");
      return { bun: Bun.version, duckdb: String(row.version), platform: process.platform, arch: process.arch };
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}

export async function checkTransfer(fields: Field[], rows: Row[]) {
  const columns = fields.map((field) => ({ name: field.name, bigquery: field.type, duckdb: localType(field) }));
  const instance = await DuckDBInstance.create(":memory:", { enable_external_access: "false" });
  try {
    const connection = await instance.connect();
    try {
      await connection.run(`CREATE TABLE probe_input (${columns.map((column) => `${identifier(column.name)} ${column.duckdb}`).join(", ")})`);
      const expressions = fields.map((field, index) => {
        const parameter = `$${index + 1}`;
        const source = field.mode === "REPEATED" || field.type === "RECORD" ? `CAST(${parameter} AS JSON)` : parameter;
        return `CAST(${source} AS ${localType(field)})`;
      });
      for (const row of rows) {
        const values = fields.map((field) => {
          const value = row[field.name];
          if (value === undefined) throw new Error(`Missing field: ${field.name}`);
          return typeof value === "object" && value !== null ? JSON.stringify(value) : value;
        });
        await connection.run(`INSERT INTO probe_input VALUES (${expressions.join(", ")})`, values);
      }
      const result = await connection.runAndReadAll(PROBE_CHECK_SQL);
      const checks = result.getRowObjectsJson();
      if (checks.length !== 1 || !Object.values(checks[0]!).every((value) => value === true)) {
        throw new Error(`BigQuery → DuckDB fidelity check failed: ${JSON.stringify(checks)}`);
      }
      return { columns, checks: checks[0]! };
    } finally {
      connection.closeSync();
    }
  } finally {
    instance.closeSync();
  }
}
