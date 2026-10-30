import type { BigQuery, JobMetadata } from "@google-cloud/bigquery";
import type { ClientFactory } from "./connection.ts";
import { ToolError } from "./contracts.ts";
import { inspectReadQuery } from "./sql-policy.ts";

export interface Source { project: string; dataset: string; table: string }

export function validateDryRun(metadata: JobMetadata): Source[] {
  const stats = metadata.statistics?.query;
  if (stats?.statementType !== "SELECT" || stats.referencedRoutines?.length) {
    throw new ToolError("SQL_POLICY", "BigQuery must validate a single SELECT without referenced routines");
  }
  const references = [...stats.referencedTables ?? [], ...stats.referencedLogicalViews ?? []];
  if (references.length >= 50) throw new ToolError("SOURCE_POLICY", "Too many source references to verify completely");
  return references.map((ref) => {
    if (!ref.projectId || !ref.datasetId || !ref.tableId) throw new ToolError("SOURCE_POLICY", "Incomplete source reference from BigQuery");
    return { project: ref.projectId, dataset: ref.datasetId, table: ref.tableId };
  });
}

export async function auditSources(client: ClientFactory, location: string, initial: Source[]): Promise<Source[]> {
  const visited = new Map<string, Source>();
  async function audit(source: Source): Promise<void> {
    const key = JSON.stringify(source);
    if (visited.has(key)) return;
    if (visited.size >= 100) throw new ToolError("SOURCE_POLICY", "Too many nested sources to verify");
    visited.set(key, source);
    const bigquery: BigQuery = client(source.project, location);
    const [metadata] = await bigquery.dataset(source.dataset).table(source.table).getMetadata();
    if (metadata.externalDataConfiguration || !["TABLE", "VIEW", "MATERIALIZED_VIEW"].includes(metadata.type ?? "")) {
      throw new ToolError("SOURCE_POLICY", `Source is not a supported native table or view: ${source.project}.${source.dataset}.${source.table}`);
    }
    const view = metadata.view ?? metadata.materializedView;
    if (["VIEW", "MATERIALIZED_VIEW"].includes(metadata.type ?? "") && !view?.query) {
      throw new ToolError("SOURCE_POLICY", "View definition is unavailable; cannot verify its read policy");
    }
    if (view?.query) {
      if (metadata.type === "VIEW" && metadata.view?.useLegacySql !== false) throw new ToolError("SOURCE_POLICY", "Legacy SQL views are not supported");
      const direct = inspectReadQuery(view.query, source.project);
      const [dry] = await bigquery.createQueryJob({ query: view.query, dryRun: true, useLegacySql: false, location });
      const discovered = validateDryRun(dry.metadata);
      for (const next of [...direct, ...discovered]) await audit(next);
    }
  }
  for (const source of initial) await audit(source);
  return [...visited.values()];
}
