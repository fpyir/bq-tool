import assert from "node:assert/strict";
import { test } from "bun:test";
import { decodeRow, probeInputSchema } from "../src/bigquery.ts";
import { checkTransfer, localType } from "../src/duckdb.ts";
import { fields, wireRow } from "./fixtures/probe.ts";

test("BigQuery wire values retain exact numeric and nested values before local transfer", async () => {
  const row = decodeRow(fields, wireRow);
  assert.equal(row.integer_value, "9223372036854775807");
  assert.equal(row.numeric_value, "12345678901234567890.123456789");
  assert.equal(row.timestamp_value, "2026-01-02T03:04:05.123456Z");
  assert.deepEqual(row.array_value, ["9007199254740993", "-1"]);
  assert.deepEqual(row.struct_value, { label: "nested", count: "9007199254740993" });
  assert.equal(row.null_value, null);
  const result = await checkTransfer(fields, [row]);
  assert.equal(Object.keys(result.checks).length, 15);
  assert.ok(Object.values(result.checks).every((value) => value === true));
  assert.deepEqual(result.columns.find((column) => column.name === "big_numeric_value"), {
    name: "big_numeric_value", bigquery: "BIGNUMERIC", duckdb: "VARCHAR",
  });
});

test("a corrupted decimal fails the fidelity check", async () => {
  const row = decodeRow(fields, wireRow);
  row.numeric_value = "12345678901234567890.123456788";
  await assert.rejects(checkTransfer(fields, [row]), /fidelity check failed/);
});

test("timestamps preserve negative and boundary microseconds, including inside structs", () => {
  const schema = [{ name: "timestamp", type: "TIMESTAMP" }];
  assert.equal(decodeRow(schema, { f: [{ v: "-1" }] }).timestamp, "1969-12-31T23:59:59.999999Z");
  assert.equal(decodeRow(schema, { f: [{ v: "253402300799999999" }] }).timestamp, "9999-12-31T23:59:59.999999Z");
  assert.deepEqual(decodeRow([{ name: "nested", type: "RECORD", fields: schema }], {
    f: [{ v: { f: [{ v: "-1" }] } }],
  }), { nested: { timestamp: "1969-12-31T23:59:59.999999Z" } });
});

test("invalid wire values, missing cells, unsupported types, and input options fail clearly", () => {
  assert.throws(() => decodeRow([{ name: "value", type: "INTEGER" }], { f: [{ v: 9007199254740992 }] }));
  assert.throws(() => decodeRow(fields, { f: [] }), /row\/schema length mismatch/);
  assert.throws(() => decodeRow([{ name: "x", type: "INTEGER" }, { name: "x", type: "INTEGER" }], { f: [{ v: "1" }, { v: "2" }] }), /unique alias/);
  assert.throws(() => localType({ name: "value", type: "GEOGRAPHY" }), /Unsupported BigQuery type/);
  assert.throws(() => probeInputSchema.parse({ project: "valid-project", location: "US", sql: "DROP TABLE x" }));
});
