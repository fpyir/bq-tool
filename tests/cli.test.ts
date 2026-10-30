import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("the TypeScript CLI runs DuckDB and returns a single JSON document", () => {
  const result = Bun.spawnSync([process.execPath, cli, "doctor"], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(result.stderr.toString(), "");
  const output = JSON.parse(result.stdout.toString());
  assert.match(output.duckdb, /^v\d+\./);
  assert.equal(output.bun, Bun.version);
});

test("CLI input failures use stderr and nonzero exit codes without contacting Google", () => {
  for (const args of [["wrong-command"], ["doctor", "--project", "valid-project"], ["probe", "--sql", "SELECT 1"]]) {
    const result = Bun.spawnSync([process.execPath, cli, ...args], { stdout: "pipe", stderr: "pipe" });
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout.toString(), "");
    assert.equal(typeof JSON.parse(result.stderr.toString()).error, "string");
  }
});
