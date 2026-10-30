import assert from "node:assert/strict";
import { test } from "bun:test";
import { inspectReadQuery } from "../src/sql-policy.ts";

test("SELECT, CTEs, nested queries, builtins and set operations preserve source references", () => {
  const sql = "WITH x AS (SELECT region FROM `test-project.curated.documents`) SELECT region, COUNT(*) AS n FROM x GROUP BY region UNION ALL SELECT region, COUNT(*) FROM `test-project`.curated.documents GROUP BY region";
  assert.deepEqual(inspectReadQuery(sql, "test-project"), [{ project: "test-project", dataset: "curated", table: "documents" }]);
  assert.deepEqual(inspectReadQuery("SELECT * FROM (SELECT * FROM curated.documents) x", "test-project"), [{ project: "test-project", dataset: "curated", table: "documents" }]);
  for (const sql of ["SELECT CURRENT_DATE(), ROW_NUMBER() OVER ()", "SELECT JSON_VALUE('{\"a\":1}', '$.a')", "SELECT '; DROP TABLE x' AS text", "SELECT * FROM UNNEST([1,2]) AS x", "SELECT CAST(@n AS INT64) AS n"]) assert.doesNotThrow(() => inspectReadQuery(sql, "test-project"));
});

test("writes, scripts, external/remote execution and disguised routine calls are rejected", () => {
  for (const sql of [
    "DELETE FROM curated.documents WHERE TRUE", "CREATE TABLE d.x AS SELECT 1", "SELECT 1; SELECT 2", "SELECT 1; DROP TABLE d.x",
    "CALL p.d.procedure()", "EXECUTE IMMEDIATE 'SELECT 1'", "EXPORT DATA OPTIONS(uri='gs://x/a',format='CSV') AS SELECT 1",
    "SELECT EXTERNAL_QUERY('connection', 'DELETE FROM users')", "SELECT * FROM EXTERNAL_QUERY('connection', 'SELECT 1')",
    "SELECT `p.d.remote`(1)", "SELECT p.d.remote(1)", "SELECT (SELECT p.d.remote(1))", "SELECT unknown_function(1)",
    "SELECT AI.GENERATE('x')", "SELECT * FROM ML.PREDICT(MODEL p.d.model, (SELECT 1))", "SELECT * FROM `p.d.events_*`",
  ]) assert.throws(() => inspectReadQuery(sql, "test-project"), /.+/, sql);
});
