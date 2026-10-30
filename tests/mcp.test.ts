import assert from "node:assert/strict";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { runtimeSchema } from "../src/core.ts";
import { sourceStdioParameters } from "./stdio.ts";

test("a real stdio client discovers schemas and executes the shared local operation", async () => {
  const transport = new StdioClientTransport(sourceStdioParameters);
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "bq-tool-tests", version: "0.0.1" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["check_runtime", "probe_bigquery"]);
    for (const tool of tools) assert.ok(tool.outputSchema);
    const result = await client.callTool({ name: "check_runtime", arguments: {} });
    assert.notEqual(result.isError, true);
    const output = runtimeSchema.parse(result.structuredContent);
    assert.equal(output.bun, Bun.version);
    assert.match(output.duckdb, /^v\d+\./);
    const invalid = await client.callTool({ name: "probe_bigquery", arguments: { project: "bad", location: "US", sql: "DELETE" } });
    assert.equal(invalid.isError, true);
    assert.equal(stderr, "");
  } finally {
    await client.close();
    await transport.close();
  }
}, 20_000);
