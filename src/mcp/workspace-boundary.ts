import { evaluateBoundary } from "../core/boundary/audit.ts";
import { waitForSharedWork } from "../core/resources/work-queue.ts";
import type { BoundaryToolArgs } from "./schemas.ts";
import { renderBoundaryAudit } from "./tools/boundary.ts";
import type { WorkspaceContext, WorkspaceManager } from "./workspace-manager.ts";

export async function runWorkspaceBoundary(
  manager: WorkspaceManager,
  context: WorkspaceContext,
  args: BoundaryToolArgs,
  options: { signal?: AbortSignal; onSync?: () => void; onAudit?: () => void; onRetry?: () => void } = {},
) {
  const { signal } = options;
  const audit = (syncProgress?: () => void, auditProgress?: () => void) => manager.runInWorkspace(context, async ctx => {
    auditProgress?.();
    return evaluateBoundary(ctx.evaluator, ctx.config, args, ctx.repo, ctx.root);
  }, { signal, onSync: syncProgress });

  const format = args.format ?? "text";
  const first = await audit(options.onSync, options.onAudit);
  if (!("stale_files" in first.payload) || !first.payload.stale_files.length) {
    return renderBoundaryAudit(first, args.max_bytes, format);
  }

  // The first audit has released the serial lane. The watcher uses that lane
  // for reconciliation and owns the shared work independently of this request.
  options.onRetry?.();
  try {
    signal?.throwIfAborted();
    await waitForSharedWork(context.watcher.reconcileForAudit(), signal);
    const retried = await audit();
    signal?.throwIfAborted();
    return renderBoundaryAudit(retried, args.max_bytes, format);
  } catch {
    if (signal?.aborted && !(signal.reason instanceof Error && signal.reason.name === "TimeoutError")) {
      signal.throwIfAborted();
    }
    const timedOut = signal?.aborted;
    // Keep any violations already proved by the available evidence.
    return renderBoundaryAudit({
      kind: "incomplete_evidence",
      payload: {
        ...first.payload,
        message: timedOut
          ? "Boundary audit deadline expired during index reconciliation or retry. The available evidence is incomplete."
          : "Boundary audit could not reconcile the index and complete the retry. The available evidence is incomplete. See workspace health for details.",
      },
    }, args.max_bytes, format);
  }
}
