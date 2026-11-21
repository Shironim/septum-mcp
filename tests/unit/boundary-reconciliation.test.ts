import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSeptumResource } from "../../src/mcp/resources-and-prompts.ts";
import { CheckBoundarySchema } from "../../src/mcp/schemas.ts";
import { runWorkspaceBoundary } from "../../src/mcp/workspace-boundary.ts";
import { WorkspaceManager } from "../../src/mcp/workspace-manager.ts";

test("reconciles a stale working-tree audit once with watcher notifications suppressed", async () => {
  const root = mkdtempSync(join(tmpdir(), "septum-boundary-reconcile-"));
  const manager = new WorkspaceManager();
  manager.initialRoot = root;
  try {
    mkdirSync(join(root, "src/orders"), { recursive: true });
    mkdirSync(join(root, "src/billing"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "septum.config.json"), JSON.stringify({
      domains: {
        orders: { root: "src/orders", forbidden_dependencies: ["billing"] },
        billing: { root: "src/billing" },
      },
    }));
    const file = join(root, "src/orders/Order.ts");
    const clean = "export const total = 1;";
    writeFileSync(file, clean);
    writeFileSync(join(root, "src/billing/Invoice.ts"), "export const invoice = 1;");
    const lease = manager.acquire(root);
    try {
      await lease.context.ready;
      const watcher = lease.context.watcher;
      const notify = spyOn(watcher, "notify").mockImplementation(() => {});
      const reconcile = spyOn(watcher, "reconcileForAudit");
      try {
        const args = CheckBoundarySchema.parse({ scope: "all", format: "json" });
        const readBoundary = async () => JSON.parse((await readSeptumResource(manager, "septum://boundaries")).contents[0]!.text);
        expect((await readBoundary()).status).toBe("approved");
        expect(reconcile).not.toHaveBeenCalled();

        writeFileSync(file, 'import { invoice } from "../billing/Invoice"; export const total = invoice;');
        const result = await runWorkspaceBoundary(manager, lease.context, args);
        expect(JSON.parse(result.content[0]!.text)).toMatchObject({ status: "rejected" });
        expect(reconcile).toHaveBeenCalledTimes(1);

        writeFileSync(file, clean);
        expect((await readBoundary()).status).toBe("approved");
        expect(reconcile).toHaveBeenCalledTimes(2);

        writeFileSync(file, "export const total = 2;");
        reconcile.mockRejectedValueOnce(new Error("injected sync failure"));
        const failed = await readBoundary();
        expect(failed.status).toBe("unknown");
        expect(failed.stale_files).toEqual(["src/orders/Order.ts"]);
        expect(failed.message).toContain("could not reconcile");
        expect(reconcile).toHaveBeenCalledTimes(3);

        // A completed reconciliation can still leave stale evidence if an edit raced it.
        reconcile.mockResolvedValueOnce(undefined);
        expect((await readBoundary()).status).toBe("unknown");
        expect(reconcile).toHaveBeenCalledTimes(4);

        const deadline = new AbortController();
        const shared = Promise.withResolvers<void>();
        reconcile.mockImplementationOnce(() => {
          deadline.abort(new DOMException("deadline", "TimeoutError"));
          return shared.promise;
        });
        const timedOut = await runWorkspaceBoundary(manager, lease.context, args, { signal: deadline.signal });
        expect(JSON.parse(timedOut.content[0]!.text).message).toContain("deadline expired");
        expect(reconcile).toHaveBeenCalledTimes(5);
        shared.resolve();

        const flush = spyOn(watcher, "flush");
        try {
          const first = watcher.reconcileForAudit();
          expect(watcher.reconcileForAudit()).toBe(first);
          await first;
          expect(flush).toHaveBeenCalledTimes(1);
        } finally {
          flush.mockRestore();
        }
      } finally {
        reconcile.mockRestore();
        notify.mockRestore();
      }
    } finally {
      lease.release();
    }
  } finally {
    await manager.close();
    rmSync(root, { recursive: true, force: true });
  }
});
