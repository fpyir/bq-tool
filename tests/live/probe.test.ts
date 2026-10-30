import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { probeInputSchema } from "../../src/bigquery.ts";
import { probeResultSchema } from "../../src/core.ts";
import { sourceStdioParameters } from "../stdio.ts";

const cli = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));

// Opt-in only: default `bun test` must never create Google query jobs.
test.skipIf(Bun.env.BQ_TOOL_LIVE !== "1")("CLI and MCP both execute the live BigQuery → DuckDB probe", async () => {
  const input = probeInputSchema.parse({ project: Bun.env.BQ_TOOL_PROJECT, location: Bun.env.BQ_TOOL_LOCATION });
  const command = Bun.spawnSync([process.execPath,
    cli, "probe", "--project", input.project, "--location", input.location,
  ], { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  assert.equal(command.exitCode, 0, command.stderr.toString());
  const cliResult = probeResultSchema.parse(JSON.parse(command.stdout.toString()));
  const env = Object.fromEntries(Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const transport = new StdioClientTransport({ ...sourceStdioParameters, env });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "bq-tool-live-check", version: "0.0.1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "probe_bigquery", arguments: input }, { timeout: 60_000 });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const mcpResult = probeResultSchema.parse(result.structuredContent);
    assert.deepEqual(mcpResult.local, cliResult.local);
    assert.deepEqual(mcpResult.source.rows, cliResult.source.rows);
    assert.equal(mcpResult.source.job.project, input.project);
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await transport.close();
  }
}, 120_000);
