import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname, tmpdir } from "node:os";
import { test } from "bun:test";
import { FakeWarehouse } from "./fixtures/warehouse.ts";
import { fields, wireRow } from "./fixtures/probe.ts";
import { Workspaces } from "../src/workspaces.ts";
import { ReadQueries } from "../src/queries.ts";
import { Catalog } from "../src/catalog.ts";
import { WorkspaceStore } from "../src/workspace-store.ts";
import { PROBE_CHECK_SQL } from "../src/probe-sql.ts";

const query = { project: "test-project", location: "US", sql: "SELECT 1 AS n", waitMs: 0 };
async function fixture(action: (root: string, warehouse: FakeWarehouse, workspaces: Workspaces) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bq-workspace-test-"));
  const warehouse = new FakeWarehouse();
  const workspaces = new Workspaces(new ReadQueries(warehouse.client), new Catalog(warehouse.client));
  try { await workspaces.open({ workspace: root }); await action(root, warehouse, workspaces); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("Parquet snapshots preserve exact and nested BigQuery types, SQL and receipts", async () => fixture(async (root, warehouse, workspaces) => {
  warehouse.pages = [{ rows: [wireRow], response: { jobComplete: true, totalRows: "1", schema: { fields }, pageToken: undefined } }] as typeof warehouse.pages;
  const saved = await workspaces.extract({ ...query, workspace: root });
  assert.equal(saved.state, "SUCCEEDED");
  const result = saved.result!;
  assert.deepEqual(result.bigquerySchema, fields);
  assert.equal(result.complete, true);
  assert.equal(result.preview.rows[0]!.integer_value, "9223372036854775807");
  assert.equal(result.preview.rows[0]!.numeric_value, "12345678901234567890.123456789");
  assert.equal(result.preview.rows[0]!.timestamp_value, "2026-01-02 03:04:05.123456+00");
  assert.equal(await Bun.file(result.sqlPath).text(), query.sql);
  assert.deepEqual(await Bun.file(result.receiptPath).json(), Object.fromEntries(Object.entries(result).filter(([key]) => !["workspace", "parquetPath", "receiptPath", "sqlPath", "preview", "deleted"].includes(key))));
  const count = warehouse.calls.length;
  const reopened = new Workspaces();
  const checked = await reopened.queryLocal({ workspace: root, inputs: [{ alias: "probe_input", resultId: result.resultId }], sql: PROBE_CHECK_SQL });
  assert.ok(Object.values(checked.rows![0]!).every((value) => value === true));
  assert.equal(Object.keys(checked.rows![0]!).length, 15);
  assert.equal(warehouse.calls.length, count);
  const same = await reopened.saveRun({ workspace: root, run: saved.run });
  assert.equal(same.result?.sha256, result.sha256);
  assert.equal(warehouse.calls.length, count);
}));

test("interrupted retrieval leaves a resumable run and cannot publish a partial result", async () => fixture(async (root, warehouse, workspaces) => {
  warehouse.pages[0]!.response.totalRows = "2";
  await assert.rejects(workspaces.extract({ ...query, workspace: root }), /Incomplete result pagination/);
  assert.deepEqual((await workspaces.listResults({ workspace: root })).results, []);
  const store = await WorkspaceStore.load(root);
  const runs = (await store.describe()).runs;
  assert.equal(runs.length, 1);
  const pending = join(root, "results", ".pending-crashed");
  await mkdir(pending);
  await writeFile(join(pending, "data.parquet"), "partial");
  warehouse.pages[0]!.response.totalRows = "1";
  const resumed = await workspaces.saveRun({ workspace: root, run: runs[0]!.run });
  assert.equal(resumed.state, "SUCCEEDED");
  assert.equal(warehouse.calls.filter((call) => call.method === "execute").length, 1);
  assert.equal((await readdir(join(root, "results"))).length, 1);
  assert.equal((await workspaces.listResults({ workspace: root })).results.length, 1);
}));

test("joins, derived snapshots and parent deletion keep independently reusable lineage", async () => fixture(async (root, warehouse, workspaces) => {
  const first = (await workspaces.extract({ ...query, workspace: root })).result!;
  warehouse.jobId = "query-2";
  warehouse.pages[0]!.rows[0]!.f[0]!.v = "3";
  const second = (await workspaces.extract({ ...query, workspace: root })).result!;
  const derived = await workspaces.queryLocal({ workspace: root, inputs: [{ alias: "a", resultId: first.resultId }, { alias: "b", resultId: second.resultId }], sql: "WITH joined AS (SELECT a.n + b.n AS total FROM a CROSS JOIN b) SELECT SUM(total) AS total FROM joined", save: true });
  assert.deepEqual(derived.preview.rows, [{ total: "9007199254740996" }]);
  assert.equal(derived.result!.origin.kind, "local");
  if (derived.result!.origin.kind === "local") assert.deepEqual(derived.result!.origin.parents.map((parent) => parent.resultId), [first.resultId, second.resultId]);
  await workspaces.deleteResult({ workspace: root, resultId: first.resultId });
  await assert.rejects(workspaces.queryLocal({ workspace: root, inputs: [{ alias: "a", resultId: first.resultId }], sql: "SELECT * FROM a" }), /was deleted/);
  const checked = await workspaces.queryLocal({ workspace: root, inputs: [{ alias: "d", resultId: derived.result!.resultId }], sql: "SELECT * FROM d" });
  assert.deepEqual(checked.rows, derived.preview.rows);
  assert.equal((await workspaces.describeResult({ workspace: root, resultId: first.resultId })).deleted, true);
  const page = await workspaces.listResults({ workspace: root, limit: 1 });
  assert.ok(page.nextAfter);
  assert.equal((await workspaces.listResults({ workspace: root, after: page.nextAfter!, limit: 100 })).results.length, 2);
}));

test("local scripts, other tables, dynamic SQL, filesystem/network access and settings are denied", async () => fixture(async (root, _warehouse, workspaces) => {
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  const inputs = [{ alias: "a", resultId: saved.resultId }];
  for (const sql of [
    "SELECT 1; SELECT 2", "DELETE FROM a", "COPY a TO '/tmp/escape'", "ATTACH '/tmp/other.db' AS x", "SET enable_external_access=true", "INSTALL httpfs", "LOAD httpfs",
    "SELECT * FROM information_schema.tables", "SELECT * FROM other", "SELECT * FROM main.a", "SELECT * FROM read_parquet('/tmp/escape')", "SELECT * FROM read_text('/etc/hosts')",
    "SELECT * FROM read_csv('https://example.com/data.csv')", "SELECT * FROM query('SELECT 1')", "SELECT getenv('HOME')", "SELECT * FROM duckdb_settings()",
    "SELECT 1 AS x, 2 AS X", "SELECT current_setting('allowed_paths') AS config FROM query_table('a')",
  ]) await assert.rejects(workspaces.queryLocal({ workspace: root, inputs, sql, save: true }), Error, sql);
  assert.equal((await workspaces.listResults({ workspace: root })).results.length, 1);
  assert.deepEqual((await workspaces.queryLocal({ workspace: root, inputs, sql: "SELECT COUNT(*) n FROM a" })).rows, [{ n: "1" }]);
}));

test("local row/byte/time budgets reject complete publication and preserve inputs", async () => fixture(async (root, _warehouse, workspaces) => {
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  const input = { workspace: root, inputs: [{ alias: "a", resultId: saved.resultId }], save: true };
  await assert.rejects(workspaces.queryLocal({ ...input, sql: "SELECT * FROM a UNION ALL SELECT * FROM a", maxRows: 1 }), /row\/byte limits/);
  await assert.rejects(workspaces.queryLocal({ ...input, sql: "SELECT repeat('a', 1000) AS long", maxResultBytes: 100 }), /row\/byte limits/);
  await assert.rejects(workspaces.queryLocal({ ...input, sql: "WITH RECURSIVE x(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM x) SELECT SUM(n) FROM x", timeoutMs: 50 }), /timed out/);
  assert.equal((await workspaces.listResults({ workspace: root })).results.length, 1);
  assert.equal((await readdir(join(root, "results"))).length, 1);
}));

test("exports are complete, explicit and never overwrite; corruption is detected", async () => fixture(async (root, _warehouse, workspaces) => {
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  const destination = await mkdtemp(join(tmpdir(), "bq-export-test-"));
  try {
    for (const format of ["parquet", "csv", "json", "sql"] as const) {
      const path = join(destination, `saved.${format}`);
      const exported = await workspaces.exportResult({ workspace: root, resultId: saved.resultId, destination: path, format });
      assert.ok(exported.bytes > 0);
      await assert.rejects(workspaces.exportResult({ workspace: root, resultId: saved.resultId, destination: path, format }), /EEXIST/);
      if (format === "sql") assert.equal(await Bun.file(path).text(), query.sql);
      if (format === "json") assert.match(await Bun.file(path).text(), /9007199254740993/);
    }
    await assert.rejects(workspaces.exportResult({ workspace: root, resultId: saved.resultId, destination: join(root, "bad.parquet") }), /outside/);
    await writeFile(saved.parquetPath, "corrupt");
    await assert.rejects(workspaces.describeResult({ workspace: root, resultId: saved.resultId }), /checksum mismatch/);
  } finally { await rm(destination, { recursive: true, force: true }); }
}));

test("empty snapshots, workspace isolation, write locks and disk limits have explicit outcomes", async () => fixture(async (root, warehouse, workspaces) => {
  warehouse.pages[0]!.rows = [];
  warehouse.pages[0]!.response.totalRows = "0";
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  assert.equal(saved.rowCount, 0);
  assert.deepEqual(saved.preview, { rows: [], complete: true });
  const other = join(root, "other");
  await workspaces.open({ workspace: other, maxDiskBytes: 1_048_576 });
  await assert.rejects(workspaces.describeResult({ workspace: other, resultId: saved.resultId }), /ENOENT/);
  await assert.rejects(workspaces.extract({ ...query, workspace: other }), /disk budget/);
  await assert.rejects(workspaces.open({ workspace: other, maxDiskBytes: 2_097_152 }), /differs/);
  const store = await WorkspaceStore.load(root);
  await store.mutate(async () => { await assert.rejects(store.mutate(async () => 1), /Another process/); });
  await mkdir(join(root, ".write-lock"));
  await writeFile(join(root, ".write-lock", "owner.json"), JSON.stringify({ pid: 2_147_483_647, host: hostname() }));
  await store.mutate(async () => 1);
  const [a, b] = await Promise.allSettled([workspaces.queryLocal({ workspace: root, inputs: [{ alias: "a", resultId: saved.resultId }], sql: "SELECT COUNT(*) n FROM a" }), workspaces.describeResult({ workspace: root, resultId: saved.resultId })]);
  assert.equal(a.status, "fulfilled"); assert.equal(b.status, "fulfilled");
}));


test("saved aggregate integers remain exact inside nested values; unsupported or overflowing types fail", async () => fixture(async (root, _warehouse, workspaces) => {
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  const inputs = [{ alias: "a", resultId: saved.resultId }];
  const derived = await workspaces.queryLocal({ workspace: root, inputs, sql: "SELECT [SUM(n)] AS values, {'HUGEINT': SUM(n)} AS nested FROM a", save: true });
  const checked = await workspaces.queryLocal({ workspace: root, inputs: [{ alias: "d", resultId: derived.result!.resultId }], sql: "SELECT * FROM d" });
  assert.deepEqual(checked.rows, [{ values: ["9007199254740993"], nested: { HUGEINT: "9007199254740993" } }]);
  for (const sql of ["SELECT INTERVAL '1 microsecond' AS x", "SELECT CAST('170141183460469231731687303715884105727' AS HUGEINT) AS x"]) {
    await assert.rejects(workspaces.queryLocal({ workspace: root, inputs, sql, save: true }));
  }
  assert.equal((await workspaces.listResults({ workspace: root })).results.length, 2);
}));

test("results larger than a DuckDB chunk remain complete, with an explicitly partial preview", async () => fixture(async (root, warehouse, workspaces) => {
  warehouse.pages[0]!.rows = Array.from({ length: 2051 }, (_, index) => ({ f: [{ v: String(index) }] }));
  warehouse.pages[0]!.response.totalRows = "2051";
  const saved = (await workspaces.extract({ ...query, workspace: root })).result!;
  assert.equal(saved.rowCount, 2051);
  assert.equal(saved.preview.rows.length, 10);
  assert.equal(saved.preview.complete, false);
  const checked = await workspaces.queryLocal({ workspace: root, inputs: [{ alias: "a", resultId: saved.resultId }], sql: "SELECT * FROM a ORDER BY n", maxRows: 3000 });
  assert.equal(checked.rows!.length, 2051);
  assert.equal(checked.rows!.at(-1)!.n, "2050");
}));


test("pending, failed and over-limit extractions remain inspectable runs without usable snapshots", async () => fixture(async (root, warehouse, workspaces) => {
  warehouse.metadata.status = { state: "RUNNING" };
  const pending = await workspaces.extract({ ...query, workspace: root });
  assert.equal(pending.state, "RUNNING");
  const files = await readdir(join(root, "runs"));
  const journal = await Bun.file(join(root, "runs", files[0]!)).json();
  assert.equal(journal.query.sql, query.sql);
  warehouse.metadata.status = { state: "DONE", errorResult: { reason: "stopped", message: "Cancelled" } };
  assert.equal((await workspaces.saveRun({ workspace: root, run: pending.run })).state, "FAILED");
  warehouse.metadata.status = { state: "DONE" };
  warehouse.pages[0]!.response.totalRows = "100001";
  assert.equal((await workspaces.saveRun({ workspace: root, run: pending.run })).state, "LIMIT_EXCEEDED");
  assert.equal((await workspaces.listResults({ workspace: root })).results.length, 0);
  assert.equal(warehouse.calls.filter((call) => call.method === "execute").length, 1);
}));

test("fresh processes recovering the same dead lock cannot overlap workspace writes", async () => fixture(async (root) => {
  await mkdir(join(root, ".write-lock"));
  await writeFile(join(root, ".write-lock", "owner.json"), JSON.stringify({ pid: 2_147_483_647, host: hostname() }));
  const workers = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/lock-worker.ts", import.meta.url)), root], { stdout: "pipe", stderr: "pipe" }));
  const outcomes = await Promise.all(workers.map(async (worker) => {
    const [exitCode, stdout, stderr] = await Promise.all([worker.exited, new Response(worker.stdout).text(), new Response(worker.stderr).text()]);
    assert.equal(exitCode, 0, stderr);
    return stdout.trim();
  }));
  assert.ok(outcomes.includes("acquired"));
  assert.ok(outcomes.every((value) => value === "acquired" || value === "busy"));
}));
