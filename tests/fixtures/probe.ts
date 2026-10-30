import type { Field } from "../../src/bigquery.ts";

export const fields: Field[] = [
  { name: "integer_value", type: "INTEGER" },
  { name: "numeric_value", type: "NUMERIC" },
  { name: "big_numeric_value", type: "BIGNUMERIC" },
  { name: "float_value", type: "FLOAT" },
  { name: "boolean_value", type: "BOOLEAN" },
  { name: "string_value", type: "STRING" },
  { name: "null_value", type: "STRING" },
  { name: "timestamp_value", type: "TIMESTAMP" },
  { name: "date_value", type: "DATE" },
  { name: "datetime_value", type: "DATETIME" },
  { name: "time_value", type: "TIME" },
  { name: "array_value", type: "INTEGER", mode: "REPEATED" },
  { name: "empty_array_value", type: "INTEGER", mode: "REPEATED" },
  { name: "struct_value", type: "RECORD", fields: [{ name: "label", type: "STRING" }, { name: "count", type: "INTEGER" }] },
  { name: "json_value", type: "JSON" },
];

export const wireRow = { f: [
  { v: "9223372036854775807" },
  { v: "12345678901234567890.123456789" },
  { v: "12345678901234567890123456789012345678.12345678901234567890123456789012345678" },
  { v: "1.25" },
  { v: "true" },
  { v: "hello, BigQuery → DuckDB" },
  { v: null },
  { v: "1767323045123456" },
  { v: "2026-01-02" },
  { v: "2026-01-02T03:04:05.123456" },
  { v: "03:04:05.123456" },
  { v: [{ v: "9007199254740993" }, { v: "-1" }] },
  { v: [] },
  { v: { f: [{ v: "nested" }, { v: "9007199254740993" }] } },
  { v: '{"large":9223372036854775807,"enabled":true}' },
] };
