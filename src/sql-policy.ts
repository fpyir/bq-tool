import { Parser } from "node-sql-parser/build/bigquery";
import { ToolError } from "./contracts.ts";

const parser = new Parser();
// Positive list: unknown or qualified routines must be reviewed before being enabled.
const functions = new Set(`
  COUNT COUNTIF SUM AVG MIN MAX ANY_VALUE ARRAY_AGG ARRAY_CONCAT_AGG STRING_AGG
  APPROX_COUNT_DISTINCT APPROX_QUANTILES APPROX_TOP_COUNT APPROX_TOP_SUM
  STDDEV STDDEV_POP STDDEV_SAMP VAR_POP VAR_SAMP VARIANCE CORR COVAR_POP COVAR_SAMP
  ROW_NUMBER RANK DENSE_RANK PERCENT_RANK CUME_DIST NTILE FIRST_VALUE LAST_VALUE NTH_VALUE LAG LEAD
  PERCENTILE_CONT PERCENTILE_DISC COALESCE IF IFNULL NULLIF GREATEST LEAST
  ABS SIGN ROUND TRUNC CEIL CEILING FLOOR MOD DIV POW POWER SQRT EXP LN LOG LOG10
  SAFE_DIVIDE SAFE_MULTIPLY SAFE_ADD SAFE_SUBTRACT SAFE_NEGATE IS_NAN IS_INF
  DATE DATETIME TIME TIMESTAMP CURRENT_DATE CURRENT_DATETIME CURRENT_TIME CURRENT_TIMESTAMP
  DATE_TRUNC DATETIME_TRUNC TIME_TRUNC TIMESTAMP_TRUNC DATE_DIFF DATETIME_DIFF TIME_DIFF TIMESTAMP_DIFF
  DATE_ADD DATE_SUB DATETIME_ADD DATETIME_SUB TIME_ADD TIME_SUB TIMESTAMP_ADD TIMESTAMP_SUB
  FORMAT_DATE FORMAT_DATETIME FORMAT_TIME FORMAT_TIMESTAMP PARSE_DATE PARSE_DATETIME PARSE_TIME PARSE_TIMESTAMP
  UNIX_DATE UNIX_SECONDS UNIX_MILLIS UNIX_MICROS DATE_FROM_UNIX_DATE TIMESTAMP_SECONDS TIMESTAMP_MILLIS TIMESTAMP_MICROS
  EXTRACT LAST_DAY GENERATE_DATE_ARRAY GENERATE_TIMESTAMP_ARRAY
  ARRAY ARRAY_LENGTH ARRAY_CONCAT ARRAY_TO_STRING ARRAY_REVERSE ARRAY_SLICE GENERATE_ARRAY UNNEST
  STRUCT TO_JSON TO_JSON_STRING PARSE_JSON JSON_VALUE JSON_QUERY JSON_VALUE_ARRAY JSON_QUERY_ARRAY
  JSON_EXTRACT JSON_EXTRACT_SCALAR JSON_EXTRACT_ARRAY JSON_EXTRACT_STRING_ARRAY JSON_KEYS JSON_TYPE JSON_STRIP_NULLS
  LAX_BOOL LAX_INT64 LAX_FLOAT64 LAX_STRING BOOL INT64 FLOAT64 STRING
  CONCAT CONCAT_WS FORMAT LOWER UPPER INITCAP LENGTH BYTE_LENGTH CHAR_LENGTH CHARACTER_LENGTH
  SUBSTR SUBSTRING LEFT RIGHT TRIM LTRIM RTRIM REPLACE SPLIT REVERSE STARTS_WITH ENDS_WITH STRPOS
  REGEXP_CONTAINS REGEXP_EXTRACT REGEXP_EXTRACT_ALL REGEXP_REPLACE INSTR LPAD RPAD REPEAT NORMALIZE NORMALIZE_AND_CASEFOLD
  TO_HEX FROM_HEX TO_BASE64 FROM_BASE64 TO_CODE_POINTS CODE_POINTS_TO_STRING CODE_POINTS_TO_BYTES
  FARM_FINGERPRINT MD5 SHA1 SHA256 SHA512 CAST SAFE_CAST OFFSET ORDINAL SAFE_OFFSET SAFE_ORDINAL
`.trim().split(/\s+/));

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export function inspectReadQuery(sql: string, project: string): { project: string; dataset: string; table: string }[] {
  let ast: unknown;
  try { ast = parser.astify(sql); }
  catch { throw new ToolError("SQL_POLICY", "Query is not supported by the BigQuery parser; use one SELECT or WITH query"); }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1 || !object(statements[0]) || statements[0].type !== "select") {
    throw new ToolError("SQL_POLICY", "Only one SELECT or WITH query is allowed");
  }
  const ctes = new Set<string>();
  const sources = new Map<string, { project: string; dataset: string; table: string }>();
  function walk(value: unknown, fn: (node: Record<string, unknown>) => void): void {
    if (Array.isArray(value)) { value.forEach((item) => walk(item, fn)); return; }
    if (!object(value)) return;
    fn(value);
    Object.values(value).forEach((item) => walk(item, fn));
  }
  walk(statements[0], (node) => {
    if (Array.isArray(node.with)) for (const cte of node.with) {
      if (object(cte) && object(cte.name) && typeof cte.name.value === "string") ctes.add(cte.name.value);
    }
  });
  walk(statements[0], (value) => {
    if (value.type === "function" || value.type === "aggr_func") {
      let name: string;
      if (typeof value.name === "string") name = value.name;
      else {
        const descriptor = value.name;
        if (!object(descriptor) || !Array.isArray(descriptor.name)) throw new ToolError("SQL_POLICY", "Unrecognized function syntax");
        const parts = [...(object(descriptor.schema) ? [descriptor.schema] : []), ...descriptor.name];
        if (parts.length !== 1 || !object(parts[0]) || typeof parts[0].value !== "string") {
          throw new ToolError("SQL_POLICY", "Qualified routines and table functions are not supported");
        }
        name = parts[0].value;
      }
      if (!functions.has(name.toUpperCase())) throw new ToolError("SQL_POLICY", `Function is not enabled for read queries: ${name}`);
    }
    if (typeof value.type === "string" && ["insert", "update", "delete", "create", "drop", "call", "export", "merge"].includes(value.type)) {
      throw new ToolError("SQL_POLICY", "Statements with side effects are not supported");
    }
    if (Array.isArray(value.from)) for (const item of value.from) {
      if (!object(item) || typeof item.table !== "string") continue;
      if (ctes.has(item.table) && !item.table.includes(".")) continue;
      const parts = item.schema ? [item.catalog ?? item.db, item.schema, item.table] : item.db ? [item.db, item.table] : item.table.split(".");
      if (parts.length === 2) parts.unshift(project);
      if (parts.length !== 3 || !parts.every((part) => typeof part === "string" && part.length > 0) || parts.some((part) => String(part).includes("*"))) {
        throw new ToolError("SQL_POLICY", "Use dataset.table or project.dataset.table references; wildcard tables are not supported");
      }
      const source = { project: String(parts[0]), dataset: String(parts[1]), table: String(parts[2]) };
      sources.set(JSON.stringify(source), source);
    }
  });
  return [...sources.values()];
}
