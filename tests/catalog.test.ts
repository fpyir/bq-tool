import assert from "node:assert/strict";
import { test } from "bun:test";
import { Catalog } from "../src/catalog.ts";
import { FakeWarehouse } from "./fixtures/warehouse.ts";

test("catalog pagination is explicit, including an empty search page", async () => {
  const fake = new FakeWarehouse();
  const catalog = new Catalog(fake.client);
  const datasets = await catalog.listDatasets({ project: "test-project", pageSize: 1, pageToken: "old" });
  assert.equal(datasets.nextPageToken, "datasets-next");
  assert.deepEqual(fake.calls[0]?.options, { autoPaginate: false, maxResults: 1, pageToken: "old" });
  const tables = await catalog.listTables({ project: "test-project", dataset: "curated", search: "missing" });
  assert.deepEqual(tables.tables, []);
  assert.equal(tables.nextPageToken, "tables-next");
  assert.equal(tables.scanned, 1);
});

test("recursive schema descriptions, sizes and physical layout survive metadata inspection", async () => {
  const fake = new FakeWarehouse();
  fake.sources.set("test-project.curated.documents", {
    type: "TABLE", location: "US", description: "Projects", numRows: "9007199254740993", numBytes: "123", lastModifiedTime: "1767323045000",
    schema: { fields: [{ name: "nested", type: "RECORD", fields: [{ name: "amount", type: "NUMERIC", description: "Exact amount", precision: "38", scale: "9" }] }] },
    timePartitioning: { type: "DAY", field: "created_at" }, clustering: { fields: ["region"] }, requirePartitionFilter: true,
  });
  const result = await new Catalog(fake.client).describeTable({ project: "test-project", dataset: "curated", table: "documents" });
  assert.equal(result.schema[0]?.fields?.[0]?.description, "Exact amount");
  assert.equal(result.rows, "9007199254740993");
  assert.equal(result.modifiedAt, "2026-01-02T03:04:05.000Z");
  assert.deepEqual(result.clustering, ["region"]);
  assert.equal(result.requirePartitionFilter, true);
});
