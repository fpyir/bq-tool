---
name: bq-tool
description: Answer product questions using data by running queries against our BigQuery data warehouse.
---

This skill contains two important tools:
1. A CLI for making queries - `query.ts`
2. A CLI for exploring table schemas - `schemas.ts`
3. A CLI for local data management - `manage.ts`

Both tools should be executed using `bunx`. Inputs are provided using stdin:
```bash
echo 'select * from ...' > bunx .skills/bq-tool/query.ts
```
The query tool can be used to run statements against both a local DuckDB instance (using CSV as the backing datastore), and BigQuery:
- `bq.<dataset>.<table>` reads from BigQuery
- `duckdb.<table>` reads from a DuckDB table

Only read operations are allowed for `bq.*` statements; the full CRUD set is available for `duckb.*` statements. Because the CLI automatically buffers BQ results in the DuckDB instance, querying across both sources in the same query - like in a join operation - works perfectly fine.

As mentioned, the result of every BigQuery statement is stored in the DuckDB instance. You can locate them for reuse using `schemas.ts`:
```bash
# the schemas CLI accepts a number of CLI flags for filtering results.
bunx .skills/schemas.ts --tag bq-result
```
You can also perform a general search for tables using `--search`:
```bash
bunx .skills/schemas.ts --search "Organisations by size"
```
By default, each new chat session gets it's own fresh DuckDB instance. If you think a particular query result or table is valuable enough to keep around for multiple sessions, you have two options:
1. Create a new tag with `manage.ts` and apply it; best suited for bespoke work that will span multiple sessions or be used across sub agents.
2. Promote the table with `manage.ts` so that it becomes part of the 'default' set of tables in every DuckDB instance.


