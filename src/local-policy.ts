import type { DuckDBConnection } from "@duckdb/node-api";
import { ToolError } from "./contracts.ts";

// Use DuckDB's own parser. No translation or permissive prefix check.
export async function inspectLocalQuery(connection: DuckDBConnection, sql: string, aliases: string[]) {
  const [serialized] = (await connection.runAndReadAll("SELECT json_serialize_sql($1) AS ast", [sql])).getRowObjectsJson();
  const ast = JSON.parse(String(serialized!.ast));
  if (ast.error || ast.statements?.length !== 1) throw new ToolError("LOCAL_SQL", "Expected one supported DuckDB SELECT/WITH statement");
  const names = new Set(aliases.map((name) => name.toLowerCase()));
  function collect(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    const node = value as Record<string, unknown>;
    const ctes = node.cte_map as { map?: { key: string }[] } | undefined;
    for (const entry of ctes?.map ?? []) names.add(entry.key.toLowerCase());
    Object.values(node).forEach(collect);
  }
  collect(ast);
  function inspect(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    const node = value as Record<string, unknown>;
    if (node.type === "BASE_TABLE" && (node.schema_name || node.catalog_name || !names.has(String(node.table_name).toLowerCase()))) {
      throw new ToolError("LOCAL_SQL", "Local tables must be explicitly selected result aliases or CTEs");
    }
    if (node.type === "TABLE_FUNCTION") {
      const fn = node.function as { function_name?: string; schema?: string; catalog?: string };
      if (fn.function_name !== "unnest" || fn.schema || fn.catalog) throw new ToolError("LOCAL_SQL", "Only UNNEST is supported as a local table function");
    }
    if (node.class === "FUNCTION" && (node.schema || node.catalog || /^(getenv|query|query_table|read_|write_|glob|http|sqlite|postgres|mysql|duckdb_|pragma_|nextval|setval)/i.test(String(node.function_name)))) {
      throw new ToolError("LOCAL_SQL", "External, dynamic, catalog and state-changing functions are not supported");
    }
    Object.values(node).forEach(inspect);
  }
  inspect(ast);
}
