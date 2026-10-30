import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";
import { datasetsOutput, tablesOutput, tableInput, tableOutput, dryRunOutput, runOutput } from "../../src/contracts.ts";
import { connectionSchema } from "../../src/connection.ts";

export async function exerciseWarehouse(cli: string[], server: StdioServerParameters) {
  const connection = connectionSchema.parse({ project: Bun.env.BQ_TOOL_PROJECT, location: Bun.env.BQ_TOOL_LOCATION });
  const target = tableInput.parse({ project: connection.project, dataset: Bun.env.BQ_TOOL_LIVE_DATASET, table: Bun.env.BQ_TOOL_LIVE_TABLE });
  const args = ["--project", connection.project, "--location", connection.location];
  const runCli = (...args: string[]) => {
    const child = Bun.spawnSync([...cli, ...args], { cwd: server.cwd ?? process.cwd(), env: server.env ?? Bun.env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    assert.equal(child.exitCode, 0, child.stderr.toString());
    assert.equal(child.stderr.toString(), "");
    return JSON.parse(child.stdout.toString());
  };
  const transport = new StdioClientTransport(server);
  const client = new Client({ name: "bq-tool-warehouse-live", version: "0.0.1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  try {
    await client.connect(transport);
    await client.listTools();
    const call = async (name: string, input: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: input }, { timeout: 60_000 });
      assert.notEqual(result.isError, true, JSON.stringify(result.content));
      return result.structuredContent;
    };
    const datasets = datasetsOutput.parse(await call("list_datasets", { project: connection.project, pageSize: 1 }));
    assert.equal(datasets.datasets.length, 1);
    if (datasets.nextPageToken) {
      const next = datasetsOutput.parse(await call("list_datasets", { project: connection.project, pageSize: 1, pageToken: datasets.nextPageToken }));
      assert.notEqual(next.datasets[0]?.dataset, datasets.datasets[0]?.dataset);
    }
    const tables = tablesOutput.parse(await call("list_tables", { project: connection.project, dataset: target.dataset, pageSize: 1 }));
    assert.equal(tables.tables.length, 1);
    if (tables.nextPageToken) {
      const next = tablesOutput.parse(await call("list_tables", { project: connection.project, dataset: target.dataset, pageSize: 1, pageToken: tables.nextPageToken }));
      assert.notEqual(next.tables[0]?.table, tables.tables[0]?.table);
    }
    const schema = tableOutput.parse(await call("describe_table", target));
    const cliSchema = tableOutput.parse(runCli("schema", "--project", target.project, "--dataset", target.dataset, "--table", target.table));
    assert.deepEqual(cliSchema.schema, schema.schema);
    const sql = `SELECT COUNT(*) AS n FROM \`${target.project}.${target.dataset}.${target.table}\``;
    const input = { ...connection, sql, maximumBytesBilled: "67108864", waitMs: 10_000 };
    dryRunOutput.parse(await call("dry_run_query", input));
    const cliResult = runOutput.parse(runCli("query", ...args, "--sql", sql, "--max-bytes-billed", "67108864", "--wait-ms", "10000"));
    const mcpResult = runOutput.parse(await call("run_query", input));
    assert.equal(cliResult.state, "SUCCEEDED");
    assert.equal(mcpResult.state, "SUCCEEDED");
    assert.deepEqual(cliResult.result, mcpResult.result);
    if (schema.rows !== null) assert.equal(cliResult.result?.rows[0]?.n, schema.rows);
    const polled = runOutput.parse(await call("get_run", mcpResult.run));
    assert.deepEqual(polled.result, mcpResult.result);
    const cliPoll = runOutput.parse(runCli("run", ...args, "--job-id", mcpResult.run.jobId));
    assert.deepEqual(cliPoll.result, mcpResult.result);
    const cancelled = runOutput.parse(await call("cancel_run", mcpResult.run));
    assert.equal(cancelled.state, "SUCCEEDED"); // A completed job must not claim it was cancelled.
    const parameters = [{ name: "n", type: "INT64", value: "9007199254740993" }, { name: "nil", type: "STRING", value: null }];
    const parameterized = runOutput.parse(await call("run_query", { ...connection, sql: "SELECT @n AS n, @nil AS nil", parameters, waitMs: 10_000 }));
    assert.deepEqual(parameterized.result?.rows, [{ n: "9007199254740993", nil: null }]);
    const limited = runOutput.parse(await call("run_query", { ...connection, sql: "SELECT x FROM UNNEST([1,2]) x", maxRows: 1, waitMs: 10_000 }));
    assert.equal(limited.state, "LIMIT_EXCEEDED");
    assert.equal(limited.result, undefined);
  } finally {
    await client.close();
    await transport.close();
  }
}
