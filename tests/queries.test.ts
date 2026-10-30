import assert from "node:assert/strict";
import { test } from "bun:test";
import { ReadQueries } from "../src/queries.ts";
import { FakeWarehouse } from "./fixtures/warehouse.ts";
import type { Query } from "@google-cloud/bigquery";

const input = { project: "test-project", location: "US", sql: "SELECT 9007199254740993 AS n", waitMs: 0 };
const ref = { project: "test-project", location: "US", jobId: "query-1" };

test("dry-run and execution carry the same SQL, named parameters and server byte limit", async () => {
  const fake = new FakeWarehouse();
  const queries = new ReadQueries(fake.client);
  const result = await queries.run({ ...input, sql: "SELECT @n AS n", parameters: [{ name: "n", type: "INT64", value: "9007199254740993" }] });
  assert.equal(result.state, "SUCCEEDED");
  assert.deepEqual(result.result?.rows, [{ n: "9007199254740993" }]);
  assert.equal(result.receipt.parameters[0]?.value, "9007199254740993");
  const { dryRun: _dryRun, ...dryOptions } = fake.calls.find((call) => call.method === "dry")!.options as Query;
  assert.deepEqual(dryOptions, fake.calls.find((call) => call.method === "execute")!.options);
  assert.equal((fake.calls.find((call) => call.method === "execute")!.options as Record<string, unknown>).maximumBytesBilled, "1073741824");
});

test("unsafe SQL, server-side routines, and over-budget scans never execute", async () => {
  for (const mode of ["sql", "routine", "budget"] as const) {
    const fake = new FakeWarehouse();
    if (mode === "routine") fake.dry.statistics!.query!.referencedRoutines = [{ projectId: "test-project", datasetId: "d", routineId: "remote" }];
    if (mode === "budget") fake.dry.statistics!.query!.totalBytesProcessed = "1073741825";
    await assert.rejects(new ReadQueries(fake.client).run({ ...input, ...(mode === "sql" ? { sql: "SELECT EXTERNAL_QUERY('c','x')" } : {}) }));
    assert.equal(fake.calls.filter((call) => call.method === "execute").length, 0);
    if (mode === "sql") assert.equal(fake.calls.length, 0);
  }
});

test("direct and nested view sources are checked before execution", async () => {
  const fake = new FakeWarehouse();
  fake.sources.set("test-project.d.v", { type: "VIEW", view: { useLegacySql: false, query: "SELECT * FROM d.external" } });
  fake.sources.set("test-project.d.external", { type: "TABLE", externalDataConfiguration: { sourceFormat: "CSV" } });
  await assert.rejects(new ReadQueries(fake.client).run({ ...input, sql: "SELECT * FROM d.v" }), /supported native/);
  assert.equal(fake.calls.some((call) => call.method === "execute"), false);
});

test("result pages preserve exact values and incomplete pagination is rejected", async () => {
  const fake = new FakeWarehouse();
  fake.pages[0]!.response.totalRows = "2";
  fake.pages[0]!.response.pageToken = "1";
  fake.pages.push({ rows: [{ f: [{ v: "-1" }] }], response: { ...fake.pages[0]!.response, pageToken: undefined } });
  const queries = new ReadQueries(fake.client);
  const result = await queries.run(input);
  assert.deepEqual(result.result?.rows, [{ n: "9007199254740993" }, { n: "-1" }]);
  fake.pages.pop();
  fake.pages[0]!.response.pageToken = undefined;
  await assert.rejects(queries.get(ref), /Incomplete result pagination/);
});

test("row and byte limits discard the entire result and cannot be raised during retrieval", async () => {
  for (const limits of [{ maxRows: 1 }, { maxResultBytes: 10 }]) {
    const fake = new FakeWarehouse();
    if ("maxRows" in limits) fake.pages[0]!.response.totalRows = "2";
    const queries = new ReadQueries(fake.client);
    const result = await queries.run({ ...input, ...limits });
    assert.equal(result.state, "LIMIT_EXCEEDED");
    assert.equal(result.result, undefined);
    await assert.rejects(queries.get({ ...ref, maxRows: 100_000 } as typeof ref));
  }
});

test("pending, failed and cancelled jobs have explicit states and polls never execute again", async () => {
  const fake = new FakeWarehouse();
  fake.metadata.status = { state: "RUNNING" };
  const queries = new ReadQueries(fake.client);
  assert.equal((await queries.run(input)).state, "RUNNING");
  assert.equal((await queries.cancel(ref)).state, "CANCEL_REQUESTED");
  assert.equal(fake.calls.some((call) => call.method === "cancel"), true);
  fake.metadata.status = { state: "DONE", errorResult: { reason: "stopped", message: "Cancelled" } };
  assert.equal((await queries.get(ref)).state, "FAILED");
  assert.equal(fake.calls.filter((call) => call.method === "execute").length, 1);
  assert.equal(fake.calls.some((call) => call.method === "results"), false);
});

test("unrelated query jobs are rejected rather than treated as BQ Tool runs", async () => {
  const fake = new FakeWarehouse();
  await assert.rejects(new ReadQueries(fake.client).get(ref), /not a BQ Tool read-query/);
});

test("empty results are complete, but repeated page tokens are rejected", async () => {
  const fake = new FakeWarehouse();
  const queries = new ReadQueries(fake.client);
  fake.pages[0]!.rows = [];
  fake.pages[0]!.response.totalRows = "0";
  const empty = await queries.run(input);
  assert.deepEqual(empty.result?.rows, []);
  assert.equal(empty.result?.complete, true);
  fake.pages[0]!.response.totalRows = "2";
  fake.pages[0]!.response.pageToken = "0";
  await assert.rejects(queries.get(ref), /repeated a results page token/);
});

test("ordinary native views are accepted while routines inside view definitions are rejected", async () => {
  const fake = new FakeWarehouse();
  fake.sources.set("test-project.d.v", { type: "VIEW", view: { useLegacySql: false, query: "SELECT * FROM d.base" } });
  fake.sources.set("test-project.d.base", { type: "TABLE" });
  const queries = new ReadQueries(fake.client);
  const dry = await queries.dryRun({ ...input, sql: "SELECT * FROM d.v" });
  assert.equal(dry.sources.length, 2);
  fake.sources.set("test-project.d.v", { type: "VIEW", view: { useLegacySql: false, query: "SELECT p.d.remote(1)" } });
  await assert.rejects(queries.run({ ...input, sql: "SELECT * FROM d.v" }), /Qualified routines/);
  assert.equal(fake.calls.some((call) => call.method === "execute"), false);
});
