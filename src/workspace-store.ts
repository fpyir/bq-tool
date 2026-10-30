import { mkdir, readFile, readdir, lstat, realpath, rename, rm, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ToolError, runRef, queryInput } from "./contracts.ts";
import { openWorkspaceInput, workspaceMetadata, workspaceOutput, resultMetadata, resultId } from "./local-contracts.ts";
import type { ResultMetadata } from "./local-contracts.ts";

export const savedRun = z.object({ run: runRef, resultId, query: queryInput, createdAt: z.string() });
export async function writeFileDurable(path: string, value: string) {
  if (Buffer.byteLength(value) > 4_194_304) throw new ToolError("WORKSPACE_FILE", "Metadata exceeds the 4 MiB file limit");
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(value); await file.sync(); } finally { await file.close(); }
}
export async function readJson(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > 4_194_304) throw new ToolError("WORKSPACE_FILE", "Expected a regular metadata file of at most 4 MiB");
  return JSON.parse(await readFile(path, "utf8"));
}
export async function hashFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile()) throw new ToolError("WORKSPACE_FILE", "Expected a regular result file");
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}
export const runResultId = (ref: z.infer<typeof runRef>) => `r_${createHash("sha256").update(JSON.stringify([ref.project, ref.location, ref.jobId])).digest("hex").slice(0, 32)}`;

export class WorkspaceStore {
  constructor(readonly root: string, readonly metadata: z.infer<typeof workspaceMetadata>) {}
  static async load(path: string) {
    const root = await realpath(resolve(path));
    return new WorkspaceStore(root, workspaceMetadata.parse(await readJson(join(root, "workspace.json"))));
  }
  static async open(raw: z.input<typeof openWorkspaceInput>) {
    const input = openWorkspaceInput.parse(raw);
    const path = resolve(input.workspace);
    await mkdir(path, { recursive: true, mode: 0o700 });
    const root = await realpath(path);
    if (!(await readdir(root)).includes("workspace.json")) {
      if ((await readdir(root)).length) throw new ToolError("WORKSPACE_PATH", "Create a workspace in an empty directory");
      const metadata = workspaceMetadata.parse({ version: 1, id: crypto.randomUUID(), createdAt: new Date().toISOString(), maxDiskBytes: input.maxDiskBytes ?? 1_073_741_824 });
      await writeFileDurable(join(root, "workspace.json"), JSON.stringify(metadata, null, 2));
    }
    const store = await WorkspaceStore.load(root);
    if (input.maxDiskBytes !== undefined && input.maxDiskBytes !== store.metadata.maxDiskBytes) throw new ToolError("WORKSPACE_CONFIG", "Existing workspace disk limit differs; opening does not change it");
    for (const directory of ["results", "runs"]) {
      await mkdir(join(root, directory), { mode: 0o700, recursive: true });
      if (!(await lstat(join(root, directory))).isDirectory()) throw new ToolError("WORKSPACE_FILE", "Expected a regular workspace directory");
    }
    return store;
  }
  async describe() {
    const runs = [];
    for (const name of (await readdir(join(this.root, "runs"))).filter((name) => /^r_[a-f0-9]{32}\.json$/.test(name)).sort()) {
      runs.push(savedRun.parse(await readJson(join(this.root, "runs", name))));
    }
    return workspaceOutput.parse({ ...this.metadata, workspace: this.root, runs });
  }
  resultPath(id: string) { return join(this.root, "results", resultId.parse(id)); }
  async get(id: string): Promise<{ metadata: ResultMetadata; deleted: boolean; parquet: string }> {
    const directory = this.resultPath(id);
    if (!(await lstat(directory)).isDirectory()) throw new ToolError("WORKSPACE_FILE", "Expected a regular result directory");
    const metadata = resultMetadata.parse(await readJson(join(directory, "receipt.json")));
    if (metadata.resultId !== id) throw new ToolError("WORKSPACE_FILE", "Result receipt does not match its identifier");
    const deleted = await Bun.file(join(directory, "deleted.json")).exists();
    return { metadata, deleted, parquet: join(directory, "data.parquet") };
  }
  async verified(id: string) {
    const result = await this.get(id);
    if (result.deleted) throw new ToolError("RESULT_DELETED", `Result ${id} was deleted`);
    if ((await lstat(result.parquet)).size !== result.metadata.parquetBytes) throw new ToolError("RESULT_INTEGRITY", `Parquet size/checksum mismatch for ${id}`);
    if (await hashFile(result.parquet) !== result.metadata.sha256) throw new ToolError("RESULT_INTEGRITY", `Parquet checksum mismatch for ${id}`);
    return result;
  }
  async usage(directory = this.root): Promise<number> {
    let bytes = 0;
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new ToolError("WORKSPACE_FILE", "Symlinks inside a workspace are not supported");
      bytes += info.isDirectory() ? await this.usage(path) : info.size;
    }
    return bytes;
  }
  async checkQuota(reserve = 0) {
    if (await this.usage() + reserve > this.metadata.maxDiskBytes) throw new ToolError("WORKSPACE_DISK_LIMIT", "Workspace exceeds its disk budget; delete unused result data before retrying");
  }
  async mutate<T>(action: () => Promise<T>): Promise<T> {
    const path = join(this.root, ".write-lock");
    const prepared = join(this.root, `.writer-${crypto.randomUUID()}`);
    await mkdir(prepared, { mode: 0o700 });
    let acquired = false;
    const busy = () => new ToolError("WORKSPACE_BUSY", "Another process is writing this workspace; retry when it finishes");
    try {
      await writeFileDurable(join(prepared, "owner.json"), JSON.stringify({ pid: process.pid, host: hostname() }));
      try { await rename(prepared, path); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        const info = await lstat(path);
        const owner = z.object({ pid: z.number().int().positive(), host: z.string() }).parse(await readJson(join(path, "owner.json")));
        let dead = false;
        if (owner.host === hostname()) {
          try { process.kill(owner.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        if (!dead) throw busy();
        // Keep the retired nonempty directory. Concurrent stale-lock recoverers use
        // the same inode-specific destination, so they cannot retire a new owner's lock.
        try { await rename(path, join(this.root, `.stale-lock-${info.dev}-${info.ino}`)); }
        catch { throw busy(); }
        try { await rename(prepared, path); } catch { throw busy(); }
      }
      acquired = true;
      // A process interrupted before atomic publication can leave only private staging data.
      for (const name of await readdir(join(this.root, "results"))) if (/^\.pending-/.test(name)) await rm(join(this.root, "results", name), { recursive: true, force: true });
      return await action();
    } finally {
      await rm(acquired ? path : prepared, { recursive: true, force: true });
    }
  }
  async publish(id: string, build: (directory: string) => Promise<ResultMetadata>) {
    const directory = join(this.root, "results", `.pending-${crypto.randomUUID()}`);
    await mkdir(directory, { mode: 0o700 });
    try {
      const metadata = resultMetadata.parse(await build(directory));
      await writeFileDurable(join(directory, "query.sql"), metadata.sql);
      await writeFileDurable(join(directory, "receipt.json"), JSON.stringify(metadata, null, 2));
      await this.checkQuota();
      await rename(directory, this.resultPath(id));
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
