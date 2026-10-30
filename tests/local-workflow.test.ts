import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { exerciseLocal } from "./local-workflow.ts";
import { sourceStdioParameters } from "./stdio.ts";

test("CLI and MCP can join saved results, save derivatives and resume in fresh processes without BigQuery", async () => {
  await exerciseLocal([process.execPath, fileURLToPath(new URL("../src/cli.ts", import.meta.url))], sourceStdioParameters);
}, 30_000);
