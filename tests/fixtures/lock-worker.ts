import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceStore } from "../../src/workspace-store.ts";
import { ToolError } from "../../src/contracts.ts";

const store = await WorkspaceStore.load(Bun.argv[2]!);
try {
  await store.mutate(async () => {
    const critical = join(store.root, ".critical-test");
    // An overlapping writer would fail this atomic directory creation.
    await mkdir(critical);
    try { await new Promise((resolve) => setTimeout(resolve, 150)); }
    finally { await rm(critical, { recursive: true }); }
  });
  console.log("acquired");
} catch (error) {
  if (error instanceof ToolError && error.code === "WORKSPACE_BUSY") console.log("busy");
  else { console.error(String(error)); process.exitCode = 1; }
}
