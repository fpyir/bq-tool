import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { probeInputSchema } from "../../src/bigquery.ts";
import { probeResultSchema, runtimeSchema } from "../../src/core.ts";
import { packagedStdioParameters } from "../stdio.ts";
import { exerciseLocal } from "../local-workflow.ts";
import { exerciseWarehouse } from "../live/warehouse-check.ts";

async function verifyExecutable(live: boolean) {
  const root = mkdtempSync(join(tmpdir(), "bq-tool-executable-"));
  const bin = join(root, "dist");
  const temporary = join(root, "tmp");
  mkdirSync(bin);
  mkdirSync(temporary);
  copyFileSync(fileURLToPath(new URL("../../dist/bq-tool", import.meta.url)), join(bin, "bq-tool"));
  copyFileSync(fileURLToPath(new URL("../../mcp.json", import.meta.url)), join(root, "mcp.json"));
  const env = {
    ...Object.fromEntries(Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    PATH: bin,
    HOME: live ? process.env.HOME! : root,
    TMPDIR: temporary,
  };
  const run = (...args: string[]) => {
    const result = Bun.spawnSync(["bq-tool", ...args], {
      cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 60_000,
    });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.equal(result.stderr.toString(), "");
    return JSON.parse(result.stdout.toString());
  };
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    // The child has only the copied executable: no Bun, Node, sources or node_modules on PATH.
    assert.equal(Bun.which("bun", { PATH: bin }), null);
    const runtime = runtimeSchema.parse(run("doctor"));
    assert.equal(runtime.bun, Bun.version);
    assert.deepEqual(readdirSync(temporary), []);
    transport = new StdioClientTransport({ ...await packagedStdioParameters(root), env });
    let stderr = "";
    transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    client = new Client({ name: "bq-tool-binary-tests", version: "0.0.1" }, {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["cancel_run", "check_runtime", "describe_result", "describe_table", "dry_run_query", "get_run", "list_datasets", "list_results", "list_tables", "open_workspace", "probe_bigquery", "query_local", "run_query", "save_query", "save_run"]);
    const result = await client.callTool({ name: "check_runtime", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(runtimeSchema.parse(result.structuredContent), runtime);
    await exerciseLocal([join(bin, "bq-tool")], { ...await packagedStdioParameters(root), env });
    if (live) {
      const input = probeInputSchema.parse({ project: Bun.env.BQ_TOOL_PROJECT, location: Bun.env.BQ_TOOL_LOCATION });
      const cliResult = probeResultSchema.parse(run("probe", "--project", input.project, "--location", input.location));
      const toolResult = await client.callTool({ name: "probe_bigquery", arguments: input }, { timeout: 60_000 });
      assert.notEqual(toolResult.isError, true, JSON.stringify(toolResult.content));
      const mcpResult = probeResultSchema.parse(toolResult.structuredContent);
      assert.deepEqual(mcpResult.local, cliResult.local);
      assert.deepEqual(mcpResult.source.rows, cliResult.source.rows);
      if (Bun.env.BQ_TOOL_LIVE_DATASET && Bun.env.BQ_TOOL_LIVE_TABLE) {
        await exerciseWarehouse([join(bin, "bq-tool")], { ...await packagedStdioParameters(root), env });
      }
    }
    assert.equal(stderr, "");
  } finally {
    await client?.close();
    await transport?.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test.skipIf(Bun.env.BQ_TOOL_BINARY !== "1")("single-file CLI and MCP work outside the checkout without Bun on PATH", async () => {
  await verifyExecutable(false);
}, 30_000);

test.skipIf(Bun.env.BQ_TOOL_BINARY !== "1" || Bun.env.BQ_TOOL_LIVE !== "1")("single-file CLI and MCP preserve the live BigQuery → DuckDB probe", async () => {
  await verifyExecutable(true);
}, 120_000);
