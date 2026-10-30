import { join } from "node:path";
import { stat } from "node:fs/promises";
import { WorkspaceStore, hashFile } from "../src/workspace-store.ts";
import { withEngine, evaluate, readOutput, normalizeParquetTypes, writeParquet, MEMORY_BYTES } from "../src/local-engine.ts";

export const demoInputs = [
  { alias: "accounts", resultId: "r_00000000000000000000000000000001" },
  { alias: "orders", resultId: "r_00000000000000000000000000000002" },
];
export const demoQuery = "SELECT a.region, COUNT(*) AS orders, SUM(o.amount) AS revenue FROM orders o JOIN accounts a USING (account_id) GROUP BY a.region ORDER BY a.region";
export const demoAnswer = [{ region: "North", orders: "4", revenue: "130.50" }, { region: "South", orders: "1", revenue: "40.00" }];

const sources = [
  `SELECT * FROM (VALUES
    (9007199254740993::BIGINT, 'North'),
    (9007199254740994::BIGINT, 'South'),
    (9007199254740995::BIGINT, 'North')
  ) AS accounts(account_id, region)`,
  `SELECT * FROM (VALUES
    (101::BIGINT, 9007199254740993::BIGINT, '2026-01-01'::DATE, 100.00::DECIMAL(18,2)),
    (102::BIGINT, 9007199254740993::BIGINT, '2026-01-02'::DATE, 25.50::DECIMAL(18,2)),
    (103::BIGINT, 9007199254740994::BIGINT, '2026-01-02'::DATE, 40.00::DECIMAL(18,2)),
    (104::BIGINT, 9007199254740995::BIGINT, '2026-01-03'::DATE, 10.00::DECIMAL(18,2)),
    (105::BIGINT, 9007199254740995::BIGINT, '2026-01-03'::DATE, -5.00::DECIMAL(18,2))
  ) AS orders(order_id, account_id, event_date, amount)`,
];

// Generate typed, inspectable fixtures using the same storage/engine code as the CLI.
// These are local VALUES queries; no credentials, warehouse client or fake remote job.
export async function createDemoWorkspace(path: string) {
  const store = await WorkspaceStore.open({ workspace: path });
  await store.mutate(async () => {
    for (const [index, input] of demoInputs.entries()) {
      const sql = sources[index]!;
      await store.publish(input.resultId, async (directory) => {
        const parquet = join(directory, "data.parquet");
        const data = await withEngine([parquet], 30_000, async (connection) => {
          await evaluate(connection, sql, [], 1000);
          await normalizeParquetTypes(connection);
          const result = await readOutput(connection, 1000, 1_048_576);
          await writeParquet(connection, parquet);
          return result;
        });
        return {
          version: 1, resultId: input.resultId, createdAt: new Date().toISOString(), complete: true,
          rowCount: data.rows.length, schema: data.schema, bigquerySchema: null,
          parquetBytes: (await stat(parquet)).size, sha256: await hashFile(parquet), sql,
          origin: { kind: "local", parents: [], limits: { maxRows: 1000, maxResultBytes: 1_048_576, timeoutMs: 30_000, memoryBytes: MEMORY_BYTES } },
        };
      });
    }
  });
}
