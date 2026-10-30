# Synthetic workspace

The assembled plugin includes `examples/workspace` with two complete Parquet snapshots. They are generated from local VALUES queries, contain no warehouse data and require no credentials. Their receipts retain those SQL literals; there are no BigQuery jobs or remote sources.

Copy the workspace to your own analysis directory before using it. Keep all writable workspaces outside the plugin installation and cache.

| Alias | Result ID | Contents |
| --- | --- | --- |
| `accounts` | `r_00000000000000000000000000000001` | Three account IDs and regions; IDs exceed JavaScript's exact integer range |
| `orders` | `r_00000000000000000000000000000002` | Five dated orders, including a negative adjustment; amounts are DECIMAL(18,2) |

`inputs.json` contains the alias/result mappings and `query.sql` joins the fixtures and aggregates by region. These are examples for local DuckDB, not GoogleSQL extraction.

Expected result:

| Region | Orders | Revenue |
| --- | ---: | ---: |
| North | 4 | 130.50 |
| South | 1 | 40.00 |

Revenue includes the negative adjustment. The total is 170.50 across five orders. This is fixture arithmetic, not a definition for your warehouse's revenue metric.

The optional [warehouse context template](warehouse-context.md) is ordinary Markdown. Keep your completed copy outside the plugin package and supply it explicitly with an analysis request.
