import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { probeInputSchema } from "./bigquery.ts";
import { checkRuntime, probeBigQuery, probeResultSchema, runtimeSchema } from "./core.ts";

export function createServer() {
  const server = new McpServer({ name: "bq-tool", version: "0.0.1" });
  server.registerTool("check_runtime", {
    title: "Check local runtime",
    description: "Check Bun and the native DuckDB engine. Runs locally without Google credentials or network access.",
    inputSchema: z.strictObject({}),
    outputSchema: runtimeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => {
    const result = await checkRuntime();
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  server.registerTool("probe_bigquery", {
    title: "Probe BigQuery and DuckDB",
    description: "Run one fixed, table-free BigQuery diagnostic SELECT using Application Default Credentials, then check exact local type transfer in DuckDB. Creates a query job in the specified billing project with a 10 MiB byte cap. Does not accept arbitrary SQL or read warehouse tables.",
    inputSchema: probeInputSchema,
    outputSchema: probeResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => {
    const result = await probeBigQuery(input);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  });
  return server;
}

export function startMcp() {
  return serveStdio(createServer, { onerror: (error) => console.error(error.message) });
}
