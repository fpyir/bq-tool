# BQ Tool

A prototype CLI and local MCP server for agent-driven BigQuery analysis. Milestones 1 and 2 provide schema discovery, bounded read-only queries, saved Parquet results, reusable local workspaces and DuckDB follow-up queries through the shared CLI/MCP core. The diagnostic probe also verifies exact BigQuery → DuckDB transfer.

## Install the desktop plugin

```sh
bun install --frozen-lockfile
bun run package
codex plugin marketplace add /absolute/path/to/bq-tool/dist/plugin
codex plugin add bq-tool@bq-tool-local
```

The build assembles a self-contained local marketplace in `dist/plugin` and a versioned target-specific `.tar.gz` archive with checksums. It includes the executable, the focused `bq-analysis` skill, installation/acceptance docs, and an offline synthetic workspace. Users of the assembled package need no Bun or Node installation. The repo marketplace entry points at the built plugin; build before installing it.

See [desktop installation and ADC setup](docs/INSTALL.md) for Codex and ChatGPT desktop instructions, cache refresh, offline first use and troubleshooting. The [desktop acceptance checklist](docs/ACCEPTANCE.md) covers skill activation and real host authentication; those UI checks are performed by the user. Local workspaces belong outside plugin source, build output and installation caches.

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

A SQL LIMIT controls returned rows; it does not replace a scan-byte cap. These limits bound inline result acceptance, not an individual network page or the cost of already completed processing. A result exceeding the row/byte cap returns `LIMIT_EXCEEDED` with no partial rows. Use `extract` to save a complete snapshot in a workspace; `query` returns inline data.

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

## Save results and continue locally

Create an explicitly named workspace outside the plugin checkout, then extract bounded data:

```sh
bq-tool workspace --workspace /absolute/path/analysis
bq-tool extract --workspace /absolute/path/analysis \
  --project your-project-id --location australia-southeast1 \
  --sql 'SELECT event_date, COUNT(*) AS n FROM analytics.events GROUP BY event_date' \
  --wait-ms 10000
bq-tool results --workspace /absolute/path/analysis
bq-tool result --workspace /absolute/path/analysis --result-id r_RESULT_ID
```

`extract` accepts the same SQL, named parameters, scan cap and timeout settings as `query`. Its materialization defaults are **100,000 rows and 100 MiB of decoded data**. It saves the complete result, returns a result ID and artifact paths, and exposes a preview of at most 10 rows / 64 KiB. `preview.complete` says whether the preview covers every saved row. No row/byte limit is silently applied as a SQL LIMIT.

If extraction returns `RUNNING`, resume retrieval with the returned job reference:

```sh
bq-tool save-run --workspace /absolute/path/analysis \
  --project your-project-id --location australia-southeast1 --job-id JOB_ID --wait-ms 10000
```

The run reference, SQL, parameters and submission limits are written before polling or downloading pages. Reopening `workspace` lists its registered extraction runs. `save-run` never submits SQL again; it retrieves that job or reuses its already saved result without contacting BigQuery. Limits are fixed by the original job. Failed or incomplete retrieval publishes no result; retry the same reference. An interrupted conversion can leave private staging files, which the next write removes. A fresh `extract` explicitly refreshes the data into a new snapshot.

For local SQL, create an inputs JSON file assigning table aliases to saved result IDs:

```json
[{"alias":"events","resultId":"r_RESULT_ID"}]
```

```sh
bq-tool local --workspace /absolute/path/analysis --inputs-file inputs.json \
  --sql 'SELECT SUM(n) AS total FROM events'
bq-tool local --workspace /absolute/path/analysis --inputs-file inputs.json \
  --sql 'SELECT event_date, n FROM events WHERE n > 10' --save
```

Join multiple results by adding more aliases to that file. Each local operation takes its workspace and inputs explicitly. It requires no Google credentials or warehouse connection. Without `--save`, it returns all complete bounded rows; with `--save`, it publishes a derived Parquet result and returns its preview and receipt. Local output defaults to 1,000 rows / 1 MiB; set `--max-rows` and `--max-result-bytes` explicitly for larger derived results, up to 100,000 rows / 100 MiB. Derived receipts record selected parent IDs, checksums, parent SQL, local SQL and execution limits.

Local queries accept one DuckDB SELECT/WITH statement over the chosen aliases, CTEs, and `UNNEST`. DuckDB's own parser checks admission; filesystem/network table functions, dynamic SQL, catalog tables, scripts, writes, attachment and extension loading are rejected. Each operation uses a fresh in-memory engine with external access disabled, only registered artifact paths allowed, locked configuration, 256 MiB DuckDB memory, two threads and disk spilling disabled. `--timeout-ms` defaults to 30 seconds, configurable from 10 ms to 60 seconds, and interrupts the engine on expiry. The memory setting bounds DuckDB's buffer management, not total process RSS. Output caps bound accepted decoded data rather than the size of an individual value allocated by the engine.

### Workspace files, limits and exports

```text
workspace.json
runs/r_<id>.json
results/r_<id>/data.parquet
results/r_<id>/receipt.json
results/r_<id>/query.sql
```

Results publish by atomic directory rename only after complete download, conversion, checksum and receipt creation. Readers see complete results; parallel writers receive `WORKSPACE_BUSY` and can retry. Dead-process write locks are recovered on the next write. Parquet checksums are verified before reuse. Schema or integrity failures produce errors instead of silently repairing data.

Workspace metadata uses format version 1. Each result carries both its stored DuckDB schema and original BigQuery schema, where applicable. Warehouse receipts retain project/location/job ID, SQL, parameters, limits, timestamps, source references, scan/billing bytes and cache status. Available source table metadata is captured after retrieval; lookup errors are retained explicitly. Modification timestamps describe observations, not ingestion watermarks or historical coverage.

Large integers and decimals remain strings in JSON responses. Typed Parquet retains native lists, structs, exact NUMERIC values and microsecond timestamps; BigQuery BIGNUMERIC remains VARCHAR. UTC TIMESTAMP becomes TIMESTAMPTZ, while DATETIME remains timezone-free. For saved derived results, DuckDB HUGEINT/UHUGEINT values, including nested values, convert to DECIMAL(38,0) to avoid Parquet floating-point conversion. Values outside that precision and unsupported saved types (such as INTERVAL, UNION or fixed-size arrays) fail explicitly. Other supported saved types are ordinary integers, booleans, floating point, strings/JSON, blobs, decimals, dates, times, timestamps, lists, named structs and maps. Local JSON temporal formatting follows DuckDB; exact values are retained.

The default workspace disk budget is **1 GiB**. Choose a budget at creation with `workspace --max-disk-bytes N` (1 MiB to 10 GiB); opening an existing workspace never changes it. Writes reserve a conservative estimate before work and check actual workspace usage before publishing. This is an application budget, not an OS filesystem quota. Each workspace allows 1,000 registered warehouse extraction runs; use another workspace afterwards. `results --limit N --after RESULT_ID` paginates receipts and deletion tombstones. Incomplete staging directories are never listed as results.

Delete data or export a complete result explicitly:

```sh
bq-tool export --workspace /absolute/path/analysis --result-id r_RESULT_ID \
  --destination /absolute/path/export.parquet
bq-tool export --workspace /absolute/path/analysis --result-id r_RESULT_ID \
  --destination /absolute/path/export.csv --format csv
bq-tool export --workspace /absolute/path/analysis --result-id r_RESULT_ID \
  --destination /absolute/path/query.sql --format sql
bq-tool delete-result --workspace /absolute/path/analysis --result-id r_RESULT_ID
```

Exports support `parquet`, `csv`, `json` (an array) and `sql`, require a new destination outside the managed workspace, and never overwrite an existing file. Parquet retains types; CSV/JSON consumers must handle numeric precision themselves. SQL parameter values remain in the receipt. Deletion removes the Parquet file but retains SQL, receipt and a tombstone. Derived snapshots remain usable after a parent is deleted, and their lineage still identifies that input. A deleted extraction is not silently downloaded again.

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
| `open_workspace` | `workspace`, optional `maxDiskBytes` | Create/reopen an explicit local workspace and list registered extraction runs |
| `save_query` | `workspace` plus query inputs | Execute and publish a complete Parquet snapshot |
| `save_run` | `workspace`, `run: {project, location, jobId}`, optional `waitMs` | Resume retrieval or reuse the existing snapshot |
| `list_results` | `workspace`, optional `limit`/`after` | Page through saved receipts and tombstones |
| `describe_result` | `workspace`, `resultId` | Inspect schemas, SQL, receipt, lineage, preview and artifact paths |
| `query_local` | `workspace`, `inputs: [{alias, resultId}]`, `sql`, optional `save`/limits | Query selected Parquet results; optionally save a derivative |
| `probe_bigquery` | `{"project":"your-project-id","location":"australia-southeast1"}` | Runs the same live diagnostic as `probe` |

All tools advertise input/output schemas and return structured content. MCP inputs are explicit; CLI environment-variable defaults do not apply to tool arguments. Query settings use `maximumBytesBilled` (a decimal string), `maxRows`, `maxResultBytes`, `timeoutMs`, `waitMs` and `parameters`, matching the CLI behavior. The server uses the current MCP SDK's stdio entry point. `save_query` uses the larger extraction defaults; `query_local` uses the smaller inline defaults even when `save: true`. Local deletion and exports are CLI commands.

For a client with a direct stdio configuration, set `command` to the absolute path of the installed `bq-tool` executable and `args` to `["mcp"]`. Ensure the launched process can discover ADC.

Root `plugin.json` and `mcp.json` provide the portable local plugin entry point. The manifest launches `${PLUGIN_ROOT}/dist/bq-tool mcp`; a plugin package must include that executable. The standalone tests verify this launch configuration outside the checkout. The package command assembles the local marketplace and cached-copy tests exercise it outside the checkout. Codex/ChatGPT desktop UI installation and skill behavior remain pending user verification. See [OpenAI's plugin packaging guide](https://developers.openai.com/plugins/build/plugins).

## Development and validation

Development runs directly from TypeScript:

```sh
bun src/cli.ts doctor
```

```sh
bun run typecheck
bun test
```

Typechecking uses Bun’s built-in [`bun check`](https://bun.sh/docs/runtime/check). Development tests run TypeScript directly; executable packaging is a separate build step. The default `bun:test` suite runs without Google credentials. It exercises catalog pagination, recursive schemas, SQL/source admission, budgets, result pagination, exact decoding, failure/cancellation states, CLI failures and real stdio tool discovery. It also checks Parquet fidelity, joins/lineage, fresh-process resume with invalid Google credentials, interrupted retrieval, atomic publication, local policy/budgets, checksums, deletion and exports. Live checks are skipped unless explicitly enabled.

Test the standalone executable:

```sh
bun run test:binary
```

This builds the binary, copies it into an isolated directory without sources or dependencies, and checks CLI and MCP behavior with no Bun on PATH, including saved-result joins, derived Parquet publication and fresh-process resume. Binary checks are skipped in the default source test suite.

Test the full distributable plugin, including archive contents, executable modes, installed manifest paths, references and the copied synthetic workspace:

```sh
bun run test:plugin
```

This unpacks the archive, verifies checksums, moves the plugin to a cache-shaped directory with spaces in its path, removes the distribution source, and exercises CLI/MCP local analysis with no Bun on PATH and an invalid Google credential path. It does not automate desktop UI or establish skill-selection behavior.

Live suites are opt-in and create diagnostic query jobs:

```sh
BQ_TOOL_PROJECT=your-project-id BQ_TOOL_LOCATION=australia-southeast1 bun run test:live
BQ_TOOL_PROJECT=your-project-id BQ_TOOL_LOCATION=australia-southeast1 bun run test:binary:live
BQ_TOOL_PROJECT=your-project-id BQ_TOOL_LOCATION=australia-southeast1 \
  BQ_TOOL_LIVE_DATASET=analytics BQ_TOOL_LIVE_TABLE=events bun run test:plugin:live
```

To include real schema/query checks, also set `BQ_TOOL_LIVE_DATASET` and `BQ_TOOL_LIVE_TABLE` to a native table in the configured project. The suite reads metadata, performs bounded COUNT aggregates, checks named parameters, extracts complete Parquet snapshots, joins them locally, saves derivatives, resumes snapshots and verifies polling/result limits through both entry points. Warehouse checks are skipped when these two variables are absent.

The live scripts set `BQ_TOOL_LIVE=1`. `test:live` and `test:binary:live` compare CLI/MCP probe results; `test:live` exercises source execution; `test:binary:live` exercises the copied standalone executable. `test:plugin:live` exercises the unpacked/cache-copied full plugin and requires the live dataset/table settings. Manual host/UI testing belongs to the user.

## Scope

Discovery, bounded warehouse queries, saved Parquet results, reusable local workspaces and local follow-up SQL are implemented through CLI and MCP. The focused analysis skill, portable package, local marketplace, synthetic examples and installation docs are implemented. Manual desktop acceptance remains pending; public-directory publication is a separate step. See [MVP_PLAN.md](MVP_PLAN.md) for the agreed scope and milestones.
