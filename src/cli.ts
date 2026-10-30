#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { checkRuntime, probeBigQuery } from "./core.ts";
import { startMcp } from "./mcp.ts";
import { Catalog } from "./catalog.ts";
import { ReadQueries } from "./queries.ts";
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
  bq-tool mcp

Use --sql TEXT or --sql-file - to read SQL from stdin.
Query options: --parameters-file FILE --max-bytes-billed N --max-rows N
               --max-result-bytes N --timeout-ms N --wait-ms N
Defaults: 1 GiB scan cap, 1000 rows, 1 MiB decoded result, 30s job timeout.
Queries require SELECT/WITH and dataset.table or project.dataset.table references.
Poll RUNNING jobs with run; wait expiry does not cancel the query.
BQ_TOOL_PROJECT and BQ_TOOL_LOCATION provide CLI defaults.
`;

const commandFlags: Record<string, string[]> = {
  doctor: [], mcp: [], probe: ["project", "location"],
  datasets: ["project", "page-size", "page-token"],
  tables: ["project", "dataset", "search", "page-size", "page-token"],
  schema: ["project", "dataset", "table"],
  "dry-run": ["project", "location", "sql", "sql-file", "parameters-file", "max-bytes-billed", "max-rows", "max-result-bytes", "timeout-ms", "wait-ms"],
  query: ["project", "location", "sql", "sql-file", "parameters-file", "max-bytes-billed", "max-rows", "max-result-bytes", "timeout-ms", "wait-ms"],
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
  const stringOptions = Object.fromEntries([...new Set(Object.values(commandFlags).flat())].map((name) => [name, { type: "string" as const }]));
  const { values: parsedValues, positionals } = parseArgs({
    args: Bun.argv.slice(2), allowPositionals: true,
    options: { ...stringOptions, help: { type: "boolean", short: "h" } },
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
  const catalog = new Catalog();
  const queries = new ReadQueries();
  let result: unknown;
  if (command === "mcp") { startMcp(); return; }
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
    const sqlText = string("sql");
    const sqlFile = string("sql-file");
    if ((sqlText === undefined) === (sqlFile === undefined)) throw new Error("Supply exactly one of --sql or --sql-file");
    const parametersFile = string("parameters-file");
    if (parametersFile === "-" && sqlFile === "-") throw new Error("SQL and parameters cannot both read stdin");
    const input = {
      ...connection(), sql: sqlText ?? await boundedText(sqlFile!),
      parameters: parametersFile ? JSON.parse(await boundedText(parametersFile)) : [],
      maximumBytesBilled: string("max-bytes-billed"), maxRows: number("max-rows"),
      maxResultBytes: number("max-result-bytes"), timeoutMs: number("timeout-ms"), waitMs: number("wait-ms"),
    };
    result = command === "dry-run" ? await queries.dryRun(input) : await queries.run(input);
  }
  await Bun.write(Bun.stdout, `${JSON.stringify(result, null, 2)}\n`);
  if (result && typeof result === "object" && "state" in result && ["FAILED", "LIMIT_EXCEEDED"].includes(String(result.state))) process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ code: error instanceof ToolError ? error.code : "ERROR", error: error instanceof Error ? error.message : "Unexpected error" }));
  process.exitCode = 1;
});
