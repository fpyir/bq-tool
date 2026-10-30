import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { Workspaces } from "../src/workspaces.ts";
import { ReadQueries } from "../src/queries.ts";
import { Catalog } from "../src/catalog.ts";
import { FakeWarehouse } from "./fixtures/warehouse.ts";
import { workspaceOutput, savedRunOutput, resultOutput, localOutput, listResultsOutput } from "../src/local-contracts.ts";

// Reusable acceptance workflow for source and standalone entry points. Warehouse extraction
// uses a synthetic client; every subsequent operation runs in a fresh CLI or stdio process.
export async function exerciseLocal(command: string[], stdio: StdioServerParameters) {
  const root = await mkdtemp(join(tmpdir(), "bq-local-workflow-"));
  const workspace = join(root, "analysis");
  const offlineEnv = { ...Bun.env, ...stdio.env, GOOGLE_APPLICATION_CREDENTIALS: join(root, "nonexistent-credentials.json") };
  const run = (...args: string[]) => {
    const child = Bun.spawnSync([...command, ...args], { stdout: "pipe", stderr: "pipe", timeout: 30_000, env: offlineEnv });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  };
  const client = new Client({ name: "bq-local-workflow", version: "0.0.1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  const transport = new StdioClientTransport({ ...stdio, env: Object.fromEntries(Object.entries(offlineEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)) });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    return response.structuredContent;
  };
  try {
    const created = workspaceOutput.parse(run("workspace", "--workspace", workspace));
    const warehouse = new FakeWarehouse();
    const core = new Workspaces(new ReadQueries(warehouse.client), new Catalog(warehouse.client));
    const query = { workspace, project: "test-project", location: "US", sql: "SELECT 1 AS n" };
    const first = savedRunOutput.parse(await core.extract(query)).result!;
    warehouse.jobId = "query-2";
    warehouse.pages[0]!.rows[0]!.f[0]!.v = "7";
    const second = savedRunOutput.parse(await core.extract(query)).result!;
    const warehouseCalls = warehouse.calls.length;
    // Different process, no inherited client or mutable server state.
    const reopened = workspaceOutput.parse(run("workspace", "--workspace", workspace));
    assert.equal(reopened.id, created.id);
    assert.equal(reopened.runs.length, 2);
    assert.equal(listResultsOutput.parse(run("results", "--workspace", workspace)).results.length, 2);
    const inputsFile = join(root, "inputs.json");
    const inputs = [{ alias: "a", resultId: first.resultId }, { alias: "b", resultId: second.resultId }];
    await Bun.write(inputsFile, JSON.stringify(inputs));
    const cli = localOutput.parse(run("local", "--workspace", workspace, "--inputs-file", inputsFile, "--sql", "SELECT a.n + b.n AS answer FROM a CROSS JOIN b", "--save"));
    assert.deepEqual(cli.preview.rows, [{ answer: "9007199254741000" }]);
    await client.connect(transport);
    const mcp = localOutput.parse(await call("query_local", { workspace, inputs, sql: "SELECT a.n + b.n AS answer FROM a CROSS JOIN b" }));
    assert.deepEqual(mcp.rows, cli.preview.rows);
    const again = workspaceOutput.parse(await call("open_workspace", { workspace }));
    assert.equal(again.id, created.id);
    const receipt = resultOutput.parse(await call("describe_result", { workspace, resultId: cli.result!.resultId }));
    assert.deepEqual(receipt.preview, cli.preview);
    const mcpSaved = localOutput.parse(await call("query_local", { workspace, inputs: [{ alias: "derived", resultId: receipt.resultId }], sql: "SELECT SUM(answer) AS answer FROM derived", save: true }));
    assert.deepEqual(mcpSaved.preview, cli.preview);
    const resumed = savedRunOutput.parse(await call("save_run", { workspace, run: reopened.runs[0]!.run }));
    assert.equal(resumed.state, "SUCCEEDED");
    const exported = join(root, "export.parquet");
    run("export", "--workspace", workspace, "--result-id", receipt.resultId, "--destination", exported);
    assert.ok(await Bun.file(exported).exists());
    run("delete-result", "--workspace", workspace, "--result-id", first.resultId);
    const deleted = resultOutput.parse(run("result", "--workspace", workspace, "--result-id", first.resultId));
    assert.equal(deleted.deleted, true);
    const check = localOutput.parse(await call("query_local", { workspace, inputs: [{ alias: "d", resultId: receipt.resultId }], sql: "SELECT answer FROM d" }));
    assert.deepEqual(check.rows, cli.preview.rows);
    assert.equal(warehouse.calls.length, warehouseCalls);
  } finally { await client.close(); await transport.close(); await rm(root, { recursive: true, force: true }); }
}
