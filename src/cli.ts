#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { checkRuntime, probeBigQuery } from "./core.ts";
import { startMcp } from "./mcp.ts";

const help = `BQ Tool — milestone 0

Usage:
  bq-tool doctor
  bq-tool probe --project PROJECT_ID --location LOCATION
  bq-tool mcp

doctor checks Bun and DuckDB without Google access.
probe runs a fixed BigQuery SELECT and verifies local type fidelity.
Project/location can also be set using BQ_TOOL_PROJECT/BQ_TOOL_LOCATION.
mcp serves the same operations over stdio; stdout is reserved for MCP.
`;

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    options: { help: { type: "boolean", short: "h" }, project: { type: "string" }, location: { type: "string" } },
  });
  if (values.help || positionals.length === 0) {
    await Bun.write(Bun.stdout, help);
    return;
  }
  const [command] = positionals;
  if (positionals.length !== 1) throw new Error("Expected one command; see --help");
  if (command !== "probe" && (values.project !== undefined || values.location !== undefined)) {
    throw new Error("--project and --location apply only to probe");
  }
  if (command === "mcp") {
    startMcp();
    return;
  }
  if (command === "doctor") {
    await Bun.write(Bun.stdout, `${JSON.stringify(await checkRuntime(), null, 2)}\n`);
    return;
  }
  if (command === "probe") {
    const project = values.project ?? Bun.env.BQ_TOOL_PROJECT;
    const location = values.location ?? Bun.env.BQ_TOOL_LOCATION;
    if (!project || !location) throw new Error("probe requires --project and --location (or BQ_TOOL_PROJECT/BQ_TOOL_LOCATION)");
    await Bun.write(Bun.stdout, `${JSON.stringify(await probeBigQuery({ project, location }), null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown command: ${command}; see --help`);
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected error" }));
  process.exitCode = 1;
});
