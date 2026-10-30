# BQ Tool

A prototype CLI and local MCP server for agent-driven BigQuery analysis. Milestone 1 provides schema discovery, bounded read-only queries, polling, cancellation and execution receipts through the shared CLI/MCP core. The diagnostic probe also verifies exact BigQuery → DuckDB transfer.

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

## Discover schemas

```sh
bq-tool datasets --project your-project-id --page-size 50
bq-tool tables --project your-project-id --dataset analytics --search events
bq-tool schema --project your-project-id --dataset analytics --table events
```

Dataset and table lists return one page and a `nextPageToken`. Pass it as `--page-token` to continue; null marks the end. Table search filters names and friendly names within that page, so an empty match page can still have a continuation token. Use `schema` for descriptions, nested fields, precise row/byte counts, modification time, partitioning, clustering and view SQL. Metadata counts remain strings and missing values remain null.

## Run bounded read queries

```sh
bq-tool dry-run --project your-project-id --location australia-southeast1 --sql-file query.sql
bq-tool query --project your-project-id --location australia-southeast1 --sql-file query.sql --wait-ms 10000
```

Use `--sql 'SELECT COUNT(*) AS n FROM analytics.events'` for inline SQL, or `--sql-file -` to read stdin. SQL and parameter inputs are each limited to 64 KiB. Table references must use `dataset.table` or `project.dataset.table`.

Every execution first passes the BigQuery dialect parser, a builtin-function allowlist, BigQuery dry-run validation, and source metadata checks. Native tables and verifiable GoogleSQL views are supported. Writes, scripts, procedures, external sources, unknown/qualified routines, wildcard tables and unsupported syntax are rejected. View definitions and their sources must be readable so their policy can be verified. There is no permissive SQL fallback. The reviewed functions are listed in [sql-policy.ts](src/sql-policy.ts).

| Option | Default | Meaning |
| --- | --- | --- |
| `--max-bytes-billed` | `1073741824` (1 GiB) | Dry-run scan estimate cap and BigQuery's execution byte cap |
| `--max-rows` | `1000` | Maximum complete result rows; configurable up to 100,000 |
| `--max-result-bytes` | `1048576` (1 MiB) | Maximum UTF-8 JSON bytes of decoded schema/rows; configurable up to 100 MiB |
| `--timeout-ms` | `30000` | BigQuery job timeout; configurable from 1 second to 10 minutes |
| `--wait-ms` | `1000` on query, `0` on run | Client polling window, from 0 to 10 seconds |

A SQL LIMIT controls returned rows; it does not replace a scan-byte cap. These limits bound inline result acceptance, not an individual network page or the cost of already completed processing. A result exceeding the row/byte cap returns `LIMIT_EXCEEDED` with no partial rows. Milestone 1 saves no local datasets.

Query output includes `state`, a `run` reference, and a `receipt` with SQL, named parameters, configured limits, source references reported by BigQuery, execution timestamps, scanned/billed bytes and cache status. `SUCCEEDED` results include schema, exact JSON-safe values, total row count and `complete: true`. A larger job can return `RUNNING`:

```sh
bq-tool run --project your-project-id --location australia-southeast1 --job-id JOB_ID --wait-ms 10000
bq-tool cancel --project your-project-id --location australia-southeast1 --job-id JOB_ID
```

Polling never resubmits SQL. Limits are stored on the BigQuery job and cannot be increased during retrieval. Only jobs submitted by BQ Tool's read-query operation are accepted. A client wait expiry returns `RUNNING`; it does not cancel the job. `CANCEL_REQUESTED` confirms a cancellation request, not that the job stopped; poll for the final outcome. Failed/cancelled jobs report `FAILED` with BigQuery's error reason.

### Named parameters

Supply `--parameters-file parameters.json` with scalar values encoded as strings or null:

```json
[{"name":"minimum_id","type":"INT64","value":"9007199254740993"}]
```

```sh
bq-tool query --project your-project-id --location australia-southeast1 --sql 'SELECT @minimum_id AS minimum_id' --parameters-file parameters.json
```

Supported parameter types are STRING, INT64, FLOAT64, BOOL, NUMERIC, BIGNUMERIC, DATE, DATETIME, TIME, TIMESTAMP and JSON. Strings preserve exact integers/decimals; parameters are bound through BigQuery's API rather than interpolated into SQL.

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

CLI responses write one JSON document to stdout. Input/policy/API failures write a JSON error to stderr and exit 1. Completed query failures and result-limit outcomes return their receipt on stdout and exit 2. Other valid outcomes, including RUNNING, exit 0. `--help` prints usage text.

## Run the MCP server

```sh
bq-tool mcp
```

This is a stdio process; a client sends MCP messages over stdin. Stdout contains protocol messages only. The server exposes:

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `check_runtime` | `{}` | Runs the same local check as `doctor` |
| `list_datasets` | `project`, optional `pageSize`/`pageToken` | List one dataset page |
| `list_tables` | `project`, `dataset`, optional `search`/pagination | List/search one table page |
| `describe_table` | `project`, `dataset`, `table` | Inspect recursive schema and physical layout |
| `dry_run_query` | `project`, `location`, `sql`, optional query settings | Validate policy and estimate scan bytes |
| `run_query` | Same as dry run | Execute a bounded read query |
| `get_run` | `project`, `location`, `jobId`, optional `waitMs` | Poll or retrieve a complete bounded result |
| `cancel_run` | `project`, `location`, `jobId` | Request cancellation |
| `probe_bigquery` | `{"project":"your-project-id","location":"australia-southeast1"}` | Runs the same live diagnostic as `probe` |

All tools advertise input/output schemas and return structured content. MCP inputs are explicit; CLI environment-variable defaults do not apply to tool arguments. Query settings use `maximumBytesBilled` (a decimal string), `maxRows`, `maxResultBytes`, `timeoutMs`, `waitMs` and `parameters`, matching the CLI behavior. The server uses the current MCP SDK's stdio entry point.

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

Typechecking uses Bun’s built-in [`bun check`](https://bun.sh/docs/runtime/check). Development tests run TypeScript directly; executable packaging is a separate build step. The default `bun:test` suite runs without Google credentials. It exercises catalog pagination, recursive schemas, SQL/source admission, budgets, result pagination, exact decoding, failure/cancellation states, CLI failures and real stdio tool discovery. Live checks are skipped unless explicitly enabled.

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

To include real schema/query checks, also set `BQ_TOOL_LIVE_DATASET` and `BQ_TOOL_LIVE_TABLE` to a native table in the configured project. The suite reads metadata, performs bounded COUNT aggregates, checks named parameters and verifies polling/result limits through both entry points. Warehouse checks are skipped when these two variables are absent.

The live scripts set `BQ_TOOL_LIVE=1` and compare the CLI and MCP probe results. `test:live` exercises source execution; `test:binary:live` exercises the copied standalone executable. Manual host/UI testing belongs to the user.

## Scope

Discovery and supported read-query execution are implemented. Saved Parquet results, reusable local workspaces and local follow-up SQL remain Milestone 2. The analysis skill and final plugin distribution remain Milestone 3. See [MVP_PLAN.md](MVP_PLAN.md) for the agreed scope and milestones.
