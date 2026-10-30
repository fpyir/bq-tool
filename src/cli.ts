#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { checkRuntime, probeBigQuery } from "./core.ts";
import { startMcp } from "./mcp.ts";
import { Catalog } from "./catalog.ts";
import { ReadQueries } from "./queries.ts";
import { Workspaces } from "./workspaces.ts";
import { ToolError } from "./contracts.ts";

const help = `BQ Tool

Usage:
  bq-tool doctor
  bq-tool probe --project PROJECT --location LOCATION
  bq-tool datasets --project PROJECT [--page-size N --page-token TOKEN]
  bq-tool tables --project PROJECT --dataset DATASET [--search TEXT --page-size N --page-token TOKEN]
  bq-tool schema --project PROJECT --dataset DATASET --table TABLE
  bq-tool dry-run --project PROJECT --location LOCATION --sql-file FILE
  bq-tool query --project PROJECT --location LOCATION --sql-file FILE
  bq-tool run --project PROJECT --location LOCATION --job-id ID [--wait-ms N]
  bq-tool cancel --project PROJECT --location LOCATION --job-id ID
  bq-tool workspace --workspace PATH [--max-disk-bytes N]
  bq-tool extract --workspace PATH --project PROJECT --location LOCATION --sql-file FILE
  bq-tool save-run --workspace PATH --project PROJECT --location LOCATION --job-id ID
  bq-tool results --workspace PATH [--after RESULT_ID --limit N]
  bq-tool result --workspace PATH --result-id ID
  bq-tool local --workspace PATH --inputs-file FILE --sql-file FILE [--save]
  bq-tool delete-result --workspace PATH --result-id ID
  bq-tool export --workspace PATH --result-id ID --destination PATH [--format parquet|csv|json|sql]
  bq-tool mcp

Use --sql TEXT or --sql-file - to read SQL from stdin.
Query options: --parameters-file FILE --max-bytes-billed N --max-rows N
               --max-result-bytes N --timeout-ms N --wait-ms N
Defaults: 1 GiB scan cap, 1000 rows, 1 MiB decoded result, 30s job timeout.
Queries require SELECT/WITH and dataset.table or project.dataset.table references.
Poll RUNNING jobs with run; wait expiry does not cancel the query.
BQ_TOOL_PROJECT and BQ_TOOL_LOCATION provide CLI defaults.
`;

const sqlFlags = ["sql", "sql-file"];
const cloudQueryFlags = ["project", "location", ...sqlFlags, "parameters-file", "max-bytes-billed", "max-rows", "max-result-bytes", "timeout-ms", "wait-ms"];
const commandFlags: Record<string, string[]> = {
  doctor: [], mcp: [], probe: ["project", "location"],
  datasets: ["project", "page-size", "page-token"],
  tables: ["project", "dataset", "search", "page-size", "page-token"],
  schema: ["project", "dataset", "table"],
  "dry-run": cloudQueryFlags,
  query: cloudQueryFlags,
  extract: ["workspace", ...cloudQueryFlags],
  workspace: ["workspace", "max-disk-bytes"],
  "save-run": ["workspace", "project", "location", "job-id", "wait-ms"],
  results: ["workspace", "after", "limit"],
  result: ["workspace", "result-id"],
  local: ["workspace", "inputs-file", ...sqlFlags, "save", "max-rows", "max-result-bytes", "timeout-ms"],
  "delete-result": ["workspace", "result-id"],
  export: ["workspace", "result-id", "destination", "format"],
  run: ["project", "location", "job-id", "wait-ms"],
  cancel: ["project", "location", "job-id"],
};

async function boundedText(path: string) {
  const reader = (path === "-" ? Bun.stdin : Bun.file(path)).stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 65_536) throw new ToolError("INPUT_LIMIT", "SQL and parameter files are limited to 64 KiB each");
      chunks.push(item.value);
    }
  } finally { await reader.cancel(); }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function main() {
  const stringOptions = Object.fromEntries([...new Set(Object.values(commandFlags).flat())].filter((name) => name !== "save").map((name) => [name, { type: "string" as const }]));
  const { values: parsedValues, positionals } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true,
    options: { ...stringOptions, save: { type: "boolean" }, help: { type: "boolean", short: "h" } },
  });
  const values: Record<string, unknown> = parsedValues;
  if (values.help || positionals.length === 0) { await Bun.write(Bun.stdout, help); return; }
  const [command] = positionals;
  if (positionals.length !== 1 || !command || !commandFlags[command]) throw new Error("Expected one known command; see --help");
  for (const flag of Object.keys(values)) if (!commandFlags[command].includes(flag)) throw new Error(`--${flag} does not apply to ${command}`);
  const string = (name: string) => { const value = values[name]; return typeof value === "string" ? value : undefined; };
  const number = (name: string) => {
    const value = string(name);
    if (value === undefined) return undefined;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`--${name} requires an integer`);
    return Number(value);
  };
  const project = () => {
    const value = string("project") ?? Bun.env.BQ_TOOL_PROJECT;
    if (!value) throw new Error("Supply --project or BQ_TOOL_PROJECT");
    return value;
  };
  const connection = () => {
    const location = string("location") ?? Bun.env.BQ_TOOL_LOCATION;
    if (!location) throw new Error("Supply --location or BQ_TOOL_LOCATION");
    return { project: project(), location };
  };
  const workspace = () => {
    const path = string("workspace");
    if (!path) throw new Error("Supply --workspace PATH");
    return path;
  };
  const sql = async () => {
    const text = string("sql"), file = string("sql-file");
    if ((text === undefined) === (file === undefined)) throw new Error("Supply exactly one of --sql or --sql-file");
    return text ?? await boundedText(file!);
  };
  const workspaces = new Workspaces();
  const catalog = new Catalog();
  const queries = new ReadQueries();
  let result: unknown;
  if (command === "mcp") { startMcp(); return; }
  else if (command === "workspace") result = await (await workspaces.open({ workspace: workspace(), maxDiskBytes: number("max-disk-bytes") })).describe();
  else if (command === "results") result = await workspaces.listResults({ workspace: workspace(), after: string("after"), limit: number("limit") });
  else if (command === "result") result = await workspaces.describeResult({ workspace: workspace(), resultId: string("result-id")! });
  else if (command === "delete-result") result = await workspaces.deleteResult({ workspace: workspace(), resultId: string("result-id")! });
  else if (command === "export") {
    const format = string("format");
    if (format && !["parquet", "csv", "json", "sql"].includes(format)) throw new Error("--format must be parquet, csv, json or sql");
    result = await workspaces.exportResult({ workspace: workspace(), resultId: string("result-id")!, destination: string("destination")!, format: format as "parquet" | "csv" | "json" | "sql" | undefined });
  } else if (command === "save-run") result = await workspaces.saveRun({ workspace: workspace(), run: { ...connection(), jobId: string("job-id")! }, waitMs: number("wait-ms") });
  else if (command === "local") {
    const inputsFile = string("inputs-file");
    if (!inputsFile) throw new Error("Supply --inputs-file with alias/resultId pairs");
    if (inputsFile === "-" && string("sql-file") === "-") throw new Error("SQL and inputs cannot both read stdin");
    result = await workspaces.queryLocal({ workspace: workspace(), inputs: JSON.parse(await boundedText(inputsFile)), sql: await sql(), save: values.save === true,
      maxRows: number("max-rows"), maxResultBytes: number("max-result-bytes"), timeoutMs: number("timeout-ms"),
    });
  }
  else if (command === "doctor") result = await checkRuntime();
  else if (command === "probe") result = await probeBigQuery(connection());
  else if (command === "datasets" || command === "tables") {
    const page = { project: project(), pageSize: number("page-size"), pageToken: string("page-token") };
    result = command === "datasets" ? await catalog.listDatasets(page) : await catalog.listTables({ ...page, dataset: string("dataset")!, search: string("search") });
  } else if (command === "schema") {
    result = await catalog.describeTable({ project: project(), dataset: string("dataset")!, table: string("table")! });
  } else if (command === "run" || command === "cancel") {
    const ref = { ...connection(), jobId: string("job-id")! };
    result = command === "run" ? await queries.get({ ...ref, waitMs: number("wait-ms") }) : await queries.cancel(ref);
  } else {
    const sqlFile = string("sql-file");
    const parametersFile = string("parameters-file");
    if (parametersFile === "-" && sqlFile === "-") throw new Error("SQL and parameters cannot both read stdin");
    const input = {
      ...connection(), sql: await sql(),
      parameters: parametersFile ? JSON.parse(await boundedText(parametersFile)) : [],
      maximumBytesBilled: string("max-bytes-billed"), maxRows: number("max-rows"),
      maxResultBytes: number("max-result-bytes"), timeoutMs: number("timeout-ms"), waitMs: number("wait-ms"),
    };
    result = command === "dry-run" ? await queries.dryRun(input) : command === "extract" ? await workspaces.extract({ ...input, workspace: workspace() }) : await queries.run(input);
  }
  await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`);
  if (result && typeof result === "object" && "state" in result && ["FAILED", "LIMIT_EXCEEDED"].includes(String(result.state))) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: error instanceof ToolError ? error.code : "ERROR", error: error instanceof Error ? error.message : "Unexpected error" }));
  process.exitCode = 1;
});
