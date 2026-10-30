# BQ Tool operations

Prefer the bundled MCP server when available. Tool names below are the operation names; use the host's advertised tool identifiers. Every tool has a structured input/output schema.

For a CLI fallback, resolve `dist/bq-tool` from the installed plugin root (two levels above this skill directory), then call that absolute executable path. It needs no Bun/Node installation. Use `--help` for the complete CLI surface. Do not rely on the source checkout, current working directory, or a globally installed executable matching this plugin.

## Warehouse discovery

| MCP operation | Arguments | CLI command |
| --- | --- | --- |
| `check_runtime` | `{}` | `doctor` |
| `probe_bigquery` | `project`, `location` | `probe --project PROJECT --location LOCATION` |
| `list_datasets` | `project`, optional `pageSize`, `pageToken` | `datasets --project PROJECT --page-size 50` |
| `list_tables` | `project`, `dataset`, optional `search`, `pageSize`, `pageToken` | `tables --project PROJECT --dataset DATASET --search TEXT` |
| `describe_table` | `project`, `dataset`, `table` | `schema --project PROJECT --dataset DATASET --table TABLE` |

Lists return `nextPageToken`; null ends pagination. Pass continuation tokens unchanged, including after an empty table-search page. Describe returns nested schema, descriptions, size/count strings, partitioning, clustering, modification time and view SQL.

## Warehouse execution

`dry_run_query`, `run_query` and `save_query` accept:

```json
{
  "project": "your-project-id",
  "location": "australia-southeast1",
  "sql": "SELECT event_date, COUNT(*) AS n FROM analytics.events GROUP BY event_date",
  "maximumBytesBilled": "1073741824",
  "maxRows": 100000,
  "maxResultBytes": 104857600,
  "timeoutMs": 30000,
  "waitMs": 1000,
  "parameters": []
}
```

`save_query` also requires `workspace: "/absolute/path/analysis"`, opened beforehand with `open_workspace`. It saves a snapshot and defaults to 100,000 rows / 100 MiB. `run_query` returns inline results and defaults to 1,000 rows / 1 MiB. Both default to a 1 GiB scan cap and 30-second job timeout. Maximum configurable result limits are 100,000 rows and 100 MiB; job timeout is 1 second to 10 minutes. Client `waitMs` is 0–10,000 ms.

Named parameters use `[{"name":"minimum_id","type":"INT64","value":"9007199254740993"}]`; scalar values are strings or null. Supported types: STRING, INT64, FLOAT64, BOOL, NUMERIC, BIGNUMERIC, DATE, DATETIME, TIME, TIMESTAMP and JSON. SQL and parameter inputs are each limited to 64 KiB. Use dataset.table or project.dataset.table references.

CLI equivalents are `dry-run`, `query` and `extract`, with `--project`, `--location`, `--sql TEXT` or `--sql-file FILE` (`-` reads stdin), `--parameters-file FILE`, `--max-bytes-billed`, `--max-rows`, `--max-result-bytes`, `--timeout-ms` and `--wait-ms`. `extract` also takes `--workspace`.

When a saved extraction is running or retrieval was interrupted:

```json
{
  "workspace": "/absolute/path/analysis",
  "run": {"project":"your-project-id","location":"australia-southeast1","jobId":"RETURNED_JOB_ID"},
  "waitMs": 10000
}
```

Pass this to `save_run`. The CLI is `save-run --workspace PATH --project PROJECT --location LOCATION --job-id ID --wait-ms 10000`. Reopening the workspace returns registered extraction references. It never resubmits a query. To inspect/cancel a warehouse job directly, use `get_run` / `cancel_run` with the flat `{project, location, jobId}` reference; `get_run` optionally takes `waitMs`. Their CLI commands are `run` and `cancel`.

Successful saved output includes a result ID, local schema, original BigQuery schema, total row count, checksum, Parquet/SQL/receipt paths and `preview: {rows, complete}`. Previews contain at most 10 rows / 64 KiB. `RUNNING`, `FAILED`, `LIMIT_EXCEEDED` and `CANCEL_REQUESTED` describe run state; only a published complete result is reusable. Receipts retain execution parameters and available source metadata. Source metadata lookup errors remain explicit.

## Workspace reuse and local SQL

- `open_workspace({workspace})` creates/reopens a workspace. Creation optionally accepts `maxDiskBytes` (default 1 GiB, range 1 MiB–10 GiB). Opening never changes an existing budget.
- `list_results({workspace, limit:50, after?})` pages through saved receipts, including deletion tombstones. Continue using `nextAfter` until null.
- `describe_result({workspace, resultId})` verifies and previews a saved result, including SQL and lineage. A deleted result retains its receipt but has no Parquet data.
- `query_local` takes explicit selected inputs and DuckDB SQL:

```json
{
  "workspace": "/absolute/path/analysis",
  "inputs": [{"alias":"events","resultId":"r_RETURNED_ID"}],
  "sql": "SELECT SUM(n) AS total FROM events",
  "save": true
}
```

Aliases must be distinct simple identifiers; `output` is reserved. Local execution accepts one SELECT/WITH over those aliases and CTEs, with UNNEST as the supported table function. Arbitrary file/network readers, catalog tables, dynamic SQL, writes, attachment and extension loading are denied.

Without `save`, local output contains complete bounded `rows`. With `save: true`, it contains a saved derived result and a preview. Both modes default to 1,000 rows / 1 MiB; `maxRows` / `maxResultBytes` can increase to 100,000 / 100 MiB. `timeoutMs` defaults to 30,000 (range 10–60,000). DuckDB has a 256 MiB memory limit, two threads and no disk spilling; this is not a total-process memory quota.

CLI equivalents: `workspace --workspace PATH`, `results --workspace PATH`, `result --workspace PATH --result-id ID`, and `local --workspace PATH --inputs-file FILE --sql-file FILE [--save]`. The inputs file is the JSON array of alias/resultId pairs.

For CLI-only requested artifact operations:

```sh
bq-tool export --workspace PATH --result-id ID --destination NEW_FILE --format parquet
bq-tool delete-result --workspace PATH --result-id ID
```

Export formats: parquet, csv, json (array), sql. Exports create a new file outside managed workspace storage and never overwrite. Deletion removes data while retaining SQL, receipt and a tombstone; already saved derivatives remain usable. Neither operation is an implicit cleanup step.

## Recovery decisions

| Outcome | Next useful action |
| --- | --- |
| `WORKSPACE_BUSY` | Retry after the other writer finishes; reads can continue |
| `RUNNING` or interrupted retrieval | `save_run` using the registered reference |
| Scan estimate over budget | Narrow source/partitions or use an already authorized higher cap |
| Result row/byte overflow | Narrow/aggregate in SQL and start a distinct extraction; partial data is not reusable |
| Local timeout, memory or result overflow | Reduce local work or use an authorized configurable limit; input snapshots remain valid |
| Checksum/size mismatch | Report damaged artifact; do not silently repair, refresh or treat it as complete |
| Missing/deleted result | Inspect receipts/lineage and explain the missing evidence; refresh explicitly if requested |
| Authentication/metadata permission failure | Report the failing operation; local snapshots remain usable without Google credentials |

CLI stdout is JSON except `--help`; diagnostics/errors use stderr. Exit 1 means input/policy/API/local failure; exit 2 means a completed warehouse query failed or exceeded result limits; exit 0 includes a valid RUNNING response. MCP reports tool errors through the host and returns structured results for valid run outcomes.
