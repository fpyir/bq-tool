import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { probeInputSchema } from "./bigquery.ts";
import { checkRuntime, probeBigQuery, probeResultSchema, runtimeSchema } from "./core.ts";
import { Workspaces } from "./workspaces.ts";
import { openWorkspaceInput, workspaceOutput, resultInput, resultOutput, listResultsInput, listResultsOutput, extractInput, saveRunInput, savedRunOutput, localInput, localOutput } from "./local-contracts.ts";
import { Catalog } from "./catalog.ts";
import { ReadQueries } from "./queries.ts";
import { datasetsInput, datasetsOutput, tablesInput, tablesOutput, tableInput, tableOutput, queryInput, dryRunOutput, getRunInput, runRef, runOutput } from "./contracts.ts";

export function createServer() {
  const server = new McpServer({ name: "bq-tool", version: "0.0.1" });
  const catalog = new Catalog();
  const queries = new ReadQueries();
  const workspaces = new Workspaces();
  const response = (result: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result });
  server.registerTool("open_workspace", {
    description: "Create or reopen an explicit local workspace path. Returns saved extraction run references for resume. Opening never refreshes results or changes an existing disk budget.", inputSchema: openWorkspaceInput, outputSchema: workspaceOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => response(await (await workspaces.open(input)).describe()));
  server.registerTool("list_results", {
    description: "List one page of immutable result receipts, including deletion tombstones. Continue with nextAfter until null. No warehouse access.", inputSchema: listResultsInput, outputSchema: listResultsOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => response(await workspaces.listResults(input)));
  server.registerTool("describe_result", {
    description: "Inspect saved SQL, schemas, receipt, lineage and a small preview. preview.complete distinguishes the preview from full saved data. No warehouse access.", inputSchema: resultInput, outputSchema: resultOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async (input) => response(await workspaces.describeResult(input)));
  server.registerTool("save_query", {
    description: "Dry-run/execute bounded GoogleSQL and save a complete Parquet snapshot in an existing workspace. Persists the job reference before retrieval. RUNNING jobs resume with save_run; never rerun SQL to poll. Default download caps: 100k rows/100 MiB.", inputSchema: extractInput, outputSchema: savedRunOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await workspaces.extract(input)));
  server.registerTool("save_run", {
    description: "Resume an extraction registered in this workspace without resubmitting SQL. Completed saved snapshots are reused without warehouse calls. Failed/incomplete retrieval never publishes partial data.", inputSchema: saveRunInput, outputSchema: savedRunOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await workspaces.saveRun(input)));
  server.registerTool("query_local", {
    description: "Run one DuckDB SELECT/WITH over explicitly selected {alias,resultId} inputs. No BigQuery calls. Returns complete bounded rows by default; save:true publishes a derived Parquet result with lineage and returns a preview. Filesystem/network readers and scripts are rejected.", inputSchema: localInput, outputSchema: localOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (input) => response(await workspaces.queryLocal(input)));
  server.registerTool("list_datasets", {
    description: "List one page of accessible datasets; follow nextPageToken until null.", inputSchema: datasetsInput, outputSchema: datasetsOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await catalog.listDatasets(input)));
  server.registerTool("list_tables", {
    description: "Search table names and friendly names in one page. Follow nextPageToken even when this page has no matches.", inputSchema: tablesInput, outputSchema: tablesOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await catalog.listTables(input)));
  server.registerTool("describe_table", {
    description: "Inspect recursive schema, descriptions, size, partitioning, clustering and view SQL without querying rows.", inputSchema: tableInput, outputSchema: tableOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await catalog.describeTable(input)));
  server.registerTool("dry_run_query", {
    description: "Validate one supported GoogleSQL SELECT/WITH, audit sources and estimate bytes without execution. Unknown/qualified routines and external sources are rejected.", inputSchema: queryInput, outputSchema: dryRunOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await queries.dryRun(input)));
  server.registerTool("run_query", {
    description: "Dry-run and execute a bounded read query. Returns complete inline data or a run reference. Result caps are stored on the job; no local result is saved.", inputSchema: queryInput, outputSchema: runOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await queries.run(input)));
  server.registerTool("get_run", {
    description: "Poll a BQ Tool read-query job or retrieve its bounded result. Never resubmits SQL. Wait expiry returns RUNNING without cancelling.", inputSchema: getRunInput, outputSchema: runOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await queries.get(input)));
  server.registerTool("cancel_run", {
    description: "Request query cancellation. CANCEL_REQUESTED does not confirm it stopped; poll get_run for the final outcome.", inputSchema: runRef, outputSchema: runOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (input) => response(await queries.cancel(input)));
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
