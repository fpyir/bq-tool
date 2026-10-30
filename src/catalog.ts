import { z } from "zod";
import { createClient } from "./connection.ts";
import type { ClientFactory } from "./connection.ts";
import { datasetsInput, datasetsOutput, tablesInput, tablesOutput, tableInput, tableOutput } from "./contracts.ts";

export class Catalog {
  constructor(private readonly client: ClientFactory = createClient) {}

  async listDatasets(input: z.input<typeof datasetsInput>) {
    const { project, pageSize, pageToken } = datasetsInput.parse(input);
    const [datasets, next] = await this.client(project).getDatasets({ autoPaginate: false, maxResults: pageSize, ...(pageToken ? { pageToken } : {}) });
    return datasetsOutput.parse({
      datasets: datasets.map((item) => ({ project, dataset: item.id, location: item.metadata.location ?? null, friendlyName: item.metadata.friendlyName ?? null })),
      nextPageToken: next?.pageToken ?? null,
    });
  }

  async listTables(input: z.input<typeof tablesInput>) {
    const { project, dataset, pageSize, pageToken, search } = tablesInput.parse(input);
    const [tables, next] = await this.client(project).dataset(dataset).getTables({ autoPaginate: false, maxResults: pageSize, ...(pageToken ? { pageToken } : {}) });
    const mapped = tables.map((item) => ({ project, dataset, table: item.id, type: item.metadata.type, friendlyName: item.metadata.friendlyName ?? null }));
    return tablesOutput.parse({
      tables: mapped.filter((item) => !search || `${item.table} ${item.friendlyName ?? ""}`.toLowerCase().includes(search.toLowerCase())),
      scanned: tables.length, nextPageToken: next?.pageToken ?? null,
    });
  }

  async describeTable(input: z.input<typeof tableInput>) {
    const { project, dataset, table } = tableInput.parse(input);
    const [metadata] = await this.client(project).dataset(dataset).table(table).getMetadata();
    return tableOutput.parse({
      project, dataset, table, type: metadata.type, location: metadata.location ?? null,
      description: metadata.description ?? null, schema: metadata.schema?.fields ?? [],
      rows: metadata.numRows ?? null, bytes: metadata.numBytes ?? null,
      modifiedAt: metadata.lastModifiedTime ? new Date(Number(metadata.lastModifiedTime)).toISOString() : null,
      partitioning: metadata.timePartitioning ?? metadata.rangePartitioning ?? null,
      clustering: metadata.clustering?.fields ?? [], requirePartitionFilter: metadata.requirePartitionFilter ?? false,
      external: !!metadata.externalDataConfiguration, viewSql: metadata.view?.query ?? metadata.materializedView?.query ?? null,
    });
  }
}
