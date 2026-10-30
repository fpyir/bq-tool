# BQ Tool

A prototype CLI and local MCP server for agent-driven BigQuery analysis. Milestone 0 proves the shared CLI → BigQuery → DuckDB and MCP → BigQuery → DuckDB paths.

## Build and install the CLI

Building and development require Bun 1.4.3 or newer. The distributed executable contains the runtime, JavaScript dependencies, and DuckDB native files; users do not need Bun, Node.js, or `node_modules`.

```sh
bun install --frozen-lockfile
bun run build
./dist/bq-tool doctor
```

The output is the single executable `dist/bq-tool`. To make it available as `bq-tool`:

```sh
mkdir -p "$HOME/.local/bin"
install -m 755 dist/bq-tool "$HOME/.local/bin/bq-tool"
export PATH="$HOME/.local/bin:$PATH"
bq-tool doctor
```

Keep that directory on your shell's PATH for future sessions. For distribution, copy the executable built for the recipient's OS and architecture.

Builds select the installed host-native DuckDB binding and embed its addon and shared library. The OS loader needs physical native files, so the executable extracts them into a private temporary directory and removes them on normal exit. No files are downloaded at startup. The standalone build is verified on macOS arm64; cross-compilation and other platform checks are not configured.

The live BigQuery probe requires Application Default Credentials (ADC), a project where the credential can create query jobs, and an explicit location.

## Check the local runtime

```sh
bq-tool doctor
```

This executes a tiny in-memory DuckDB query and returns Bun, DuckDB, platform and architecture details as JSON. It requires no Google credentials or network access.

## Probe BigQuery and local type transfer

```sh
bq-tool probe --project your-project-id --location australia-southeast1
```

The probe authenticates using ADC, dry-runs a fixed table-free `SELECT`, then creates a real diagnostic job with a 10 MiB maximum-bytes-billed setting and a 30-second job timeout. It transfers the one-row result to in-memory DuckDB and checks 15 values, including exact large integers and decimals, microsecond timestamps, nulls, arrays, a struct and JSON. It reads no warehouse tables and creates no permanent warehouse objects. The result includes the job ID, processed/billed bytes, source schema, source values, local types and individual check outcomes.

`INT64` and `NUMERIC` become `BIGINT` and `DECIMAL(38,9)`. `BIGNUMERIC` stays exact text (`VARCHAR`) because its full precision exceeds DuckDB's decimal precision. Numeric source values are represented as strings in JSON so JavaScript cannot round them. `TIMESTAMP` is decoded to UTC with six fractional digits and stored as `TIMESTAMPTZ`; `DATETIME` keeps its timezone-free meaning. Unsupported transfer types fail explicitly. This is a representative type spike, not a complete BigQuery type converter.

You can also supply the configuration through environment variables:

```sh
export BQ_TOOL_PROJECT=your-project-id
export BQ_TOOL_LOCATION=australia-southeast1
bq-tool probe
```

Flags take precedence. The tool does not infer or change your active gcloud project. gcloud CLI authentication and ADC are separate. If client-library authentication fails, configure ADC using `gcloud auth application-default login`, or provide your organization's supported ADC configuration. Do not put credentials in this repository or the plugin manifest. See [Google's ADC setup](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc).

Successful CLI operations write one JSON document to stdout. Failures write a JSON error to stderr and exit nonzero. `--help` prints usage text.

## Run the MCP server

```sh
bq-tool mcp
```

This is a stdio process; a client sends MCP messages over stdin. Stdout contains protocol messages only. The server exposes:

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `check_runtime` | `{}` | Runs the same local check as `doctor` |
| `probe_bigquery` | `{"project":"your-project-id","location":"australia-southeast1"}` | Runs the same live diagnostic as `probe` |

Both tools advertise input/output schemas and return structured content. MCP probe inputs are explicit; the CLI environment-variable defaults do not apply to tool arguments. The server uses the current MCP SDK's stdio entry point.

For a client with a direct stdio configuration, set `command` to the absolute path of the installed `bq-tool` executable and `args` to `["mcp"]`. Ensure the launched process can discover ADC.

Root `plugin.json` and `mcp.json` provide the portable local plugin entry point. The manifest launches `${PLUGIN_ROOT}/dist/bq-tool mcp`; a plugin package must include that executable. The standalone tests verify this launch configuration outside the checkout. Marketplace distribution, cached-copy assembly and manual installation in Codex/ChatGPT desktop remain milestone 3. See [OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

## Development and validation

Development runs directly from TypeScript:

```sh
bun src/cli.ts doctor
```

```sh
bun run typecheck
bun test
```

Typechecking uses Bun’s built-in [`bun check`](https://bun.sh/docs/runtime/check). Development tests run TypeScript directly; executable packaging is a separate build step. The default `bun:test` suite runs without Google credentials. It verifies local transfer against synthetic REST fixtures, checks CLI failure behavior using `Bun.spawnSync`, and starts a real stdio client for discovery and tool calls. Live checks are skipped unless explicitly enabled.

Test the standalone executable:

```sh
bun run test:binary
```

This builds the binary, copies it into an isolated directory without sources or dependencies, and checks CLI and MCP behavior with no Bun on PATH. Binary checks are skipped in the default source test suite.

Live suites are opt-in and create diagnostic query jobs:

```sh
BQ_TOOL_PROJECT=your-project-id BQ_TOOL_LOCATION=australia-southeast1 bun run test:live
BQ_TOOL_PROJECT=your-project-id BQ_TOOL_LOCATION=australia-southeast1 bun run test:binary:live
```

The live scripts set `BQ_TOOL_LIVE=1` and compare the CLI and MCP probe results. `test:live` exercises source execution; `test:binary:live` exercises the copied standalone executable. Manual host/UI testing belongs to the user.

## Scope

General SQL execution, warehouse discovery, saved Parquet results, reusable workspaces and the analysis skill follow in later milestones. The current probe accepts no arbitrary SQL and persists no results. See [MVP_PLAN.md](MVP_PLAN.md) for the agreed scope and milestones.
