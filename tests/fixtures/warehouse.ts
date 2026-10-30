import type { BigQuery, JobMetadata, Query } from "@google-cloud/bigquery";
import type { ClientFactory } from "../../src/connection.ts";

export class FakeWarehouse {
  jobId = "query-1";
  calls: { method: string; options: unknown }[] = [];
  dry: JobMetadata = { statistics: { query: { statementType: "SELECT", totalBytesProcessed: "128", referencedTables: [] } } };
  metadata: JobMetadata = { status: { state: "DONE" }, statistics: { query: { statementType: "SELECT", totalBytesProcessed: "128", totalBytesBilled: "10485760", cacheHit: false } } };
  pages = [{ rows: [{ f: [{ v: "9007199254740993" }] }], response: { jobComplete: true, totalRows: "1", schema: { fields: [{ name: "n", type: "INTEGER" }] }, pageToken: undefined as string | undefined } }];
  sources = new Map<string, Record<string, unknown>>();
  metadataReads = 0;
  finishAfterReads: number | undefined;

  readonly client: ClientFactory = (project) => ({
    getDatasets: async (options: unknown) => {
      this.calls.push({ method: "datasets", options });
      return [[{ id: "curated", metadata: { location: "US" } }], { pageToken: "datasets-next" }];
    },
    dataset: (dataset: string) => ({
      getTables: async (options: unknown) => {
        this.calls.push({ method: "tables", options });
        return [[{ id: "documents", metadata: { type: "TABLE", friendlyName: "Documents" } }], { pageToken: "tables-next" }];
      },
      table: (table: string) => ({ getMetadata: async () => {
        const key = `${project}.${dataset}.${table}`;
        this.calls.push({ method: "source", options: key });
        const source = this.sources.get(key);
        if (!source) throw new Error(`No fake source: ${key}`);
        return [source];
      } }),
    }),
    createQueryJob: async (options: Query) => {
      this.calls.push({ method: options.dryRun ? "dry" : "execute", options });
      if (options.dryRun) return [{ metadata: structuredClone(this.dry) }];
      this.metadata.configuration = {
        query: { query: options.query!, useLegacySql: options.useLegacySql!, maximumBytesBilled: options.maximumBytesBilled!, queryParameters: options.queryParameters! },
        labels: options.labels!, jobTimeoutMs: String(options.jobTimeoutMs),
      };
      return [{ id: this.jobId, metadata: this.metadata }];
    },
    job: () => ({
      getMetadata: async () => {
        this.metadataReads++;
        if (this.finishAfterReads && this.metadataReads >= this.finishAfterReads) this.metadata.status = { state: "DONE" };
        return [structuredClone(this.metadata)];
      },
      getQueryResults: async (options: { pageToken?: string }) => {
        this.calls.push({ method: "results", options });
        const page = this.pages[options.pageToken ? Number(options.pageToken) : 0]!;
        return [page.rows, page.response.pageToken ? { pageToken: page.response.pageToken } : null, page.response];
      },
      cancel: async () => { this.calls.push({ method: "cancel", options: {} }); return [{}]; },
    }),
  } as unknown as BigQuery);
}
