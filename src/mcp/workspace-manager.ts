import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigLoader, resolveDatabasePath } from '../core/config/loader.ts';
import type { ValidatedSeptumConfig } from '../core/config/schema.ts';
import { SeptumDatabase } from '../core/database/client.ts';
import { SeptumRepository } from '../core/database/repository.ts';
import { BoundaryEvaluator } from '../core/boundary/evaluator.ts';
import { ModuleResolver } from '../core/resolver/module-resolver.ts';
import { findProjectRoot, isAppHostDirectory, isPathContained, PROJECT_ROOT_MARKERS } from '../core/resolver/path-resolver.ts';
import { IngestionPipeline } from '../core/ingestion/pipeline.ts';
import { RESOURCE_LIMITS } from '../core/resources/limits.ts';
import { ReadWriteWorkQueue, waitForSharedWork } from '../core/resources/work-queue.ts';
import { WatchBudget, WorkspaceWatcher } from './workspace-watcher.ts';
import { DomainRootConflictError } from '../core/config/domain-ownership.ts';
import { WorkspaceBusyError } from '../core/errors.ts';
import { SeptumTelemetry } from '../core/telemetry/telemetry.ts';

function isSafeWorkspaceRoot(root: string): boolean {
  try {
    return statSync(root).isDirectory() && root !== dirname(root) && root !== realpathSync(homedir()) && !isAppHostDirectory(root);
  } catch {
    return false;
  }
}

export function normalizeClientRoots(roots: ReadonlyArray<{ uri?: string }>): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of roots) {
    if (!entry?.uri || typeof entry.uri !== 'string') continue;
    let rawPath: string;
    try {
      if (entry.uri.startsWith('file://')) {
        rawPath = fileURLToPath(entry.uri);
      } else if (isAbsolute(entry.uri)) {
        rawPath = entry.uri;
      } else {
        continue;
      }
      const canonical = realpathSync(rawPath);
      if (!isSafeWorkspaceRoot(canonical) || seen.has(canonical)) continue;
      seen.add(canonical);
      normalized.push(canonical);
    } catch {
      // Ignore invalid or inaccessible client root URIs.
    }
  }
  return normalized;
}

export function resolveServerWorkspace(options: {workspacePath?: string; filePath?: string; fallbackRoot?: string; knownRoots?: string[]; clientRoots?: string[]; initial?: boolean; cwd?: string} = {}): string {
  const cwd = options.cwd || process.cwd();
  const explicit = options.workspacePath || (!options.filePath ? process.env.SEPTUM_WORKSPACE_ROOT || process.env.WORKSPACE_ROOT : undefined);
  let root: string;
  if (explicit) {
    root = resolve(cwd, explicit);
  } else if (options.filePath && (isAbsolute(options.filePath) || /[\\/]/.test(options.filePath))) {
    const absTarget = resolve(options.fallbackRoot || cwd, options.filePath);
    // SV-04: Prefer known/registered workspace roots that already contain this file before falling back to nested markers
    const containingKnown = options.knownRoots?.find(known => isPathContained(absTarget, known));
    if (containingKnown && isWorkspaceInitialized(containingKnown)) {
      root = containingKnown;
    } else {
      root = findProjectRoot(absTarget);
    }
  } else if (options.clientRoots && options.clientRoots.length > 0) {
    root = options.clientRoots.find(isWorkspaceInitialized) ?? options.clientRoots[0]!;
  } else if (options.fallbackRoot) {
    root = options.fallbackRoot;
  } else {
    if (!PROJECT_ROOT_MARKERS.some(marker => existsSync(join(cwd, marker)))) throw new Error('No project marker in CWD. Set SEPTUM_WORKSPACE_ROOT to an explicit workspace directory.');
    root = cwd;
  }
  root = realpathSync(root);
  if (!isSafeWorkspaceRoot(root)) throw new Error(`Unsafe Septum serve workspace: ${root}`);

  // SV-04: Validate file-workspace consistency when both are present
  if (options.workspacePath && options.filePath && isAbsolute(options.filePath)) {
    if (!isPathContained(options.filePath, root)) {
      throw new Error(`File '${options.filePath}' does not belong to workspace '${root}'.`);
    }
  }

  return root;
}

export function isWorkspaceInitialized(root: string): boolean {
  try {
    // SV-03: Pure .septum directory without db is uninitialized
    return existsSync(join(root, ".septum", "septum.db"));
  } catch {
    return false;
  }
}

export interface WorkspaceContext {
  root: string;
  config: ValidatedSeptumConfig;
  db: SeptumDatabase;
  repo: SeptumRepository;
  evaluator: BoundaryEvaluator;
  pipeline: IngestionPipeline;
  ready: Promise<void>;
  watcher: WorkspaceWatcher;
  queue: ReadWriteWorkQueue;
}
interface Entry { context: WorkspaceContext; leases: number; lastUsed: number; initializing: boolean; abort: AbortController; disposal?: Promise<void> }
export interface WorkspaceLease { context: WorkspaceContext; release(): void }

export class WorkspaceManager {
  private contexts = new Map<string, Entry>();
  private budget = new WatchBudget();
  private disposals = new Set<Promise<void>>();
  private closed = false;
  private activeRequests = 0;
  private closing: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setInterval>;
  initialRoot?: string;
  lastRoot?: string;
  private _clientRoots: string[] = [];
  get activeRoots(): string[] { return [...this.contexts.keys()]; }
  get clientRoots(): string[] { return [...this._clientRoots]; }
  get primaryClientRoot(): string | undefined {
    if (this._clientRoots.length === 0) return undefined;
    return this._clientRoots.find(isWorkspaceInitialized) ?? this._clientRoots[0];
  }
  setClientRoots(roots: ReadonlyArray<{ uri?: string }>): string[] {
    this._clientRoots = normalizeClientRoots(roots);
    return [...this._clientRoots];
  }
  constructor(private readonly now: () => number = Date.now) {
    this.idleTimer = setInterval(() => {
      void this.expireIdle().catch(error =>
        SeptumTelemetry.recordSystemEvent({
          level: 'WARN',
          component: 'workspace_manager',
          event: 'idle_expiration_failed',
          fields: { message: String(error).slice(0, 256) },
          workspaceRoot: this.lastRoot ?? this.primaryClientRoot ?? this.initialRoot ?? null,
        })
      );
    }, 60_000);
    this.idleTimer.unref();
  }
  get size(): number { return this.contexts.size; }
  get watchCount(): number { return this.budget.count; }
  get syncDurationMs(): number { return Math.max(0, ...[...this.contexts.values()].map(entry => Number(entry.context.repo.getMeta("sync_duration_ms") || 0))); }
  get pendingPaths(): number { return [...this.contexts.values()].reduce((n, entry) => n + entry.context.watcher.pendingCount, 0); }

  /** Inspect an active context synchronously without renewing or creating it. */
  peek(rawRoot: string): WorkspaceContext | undefined {
    let root = rawRoot;
    try {
      root = realpathSync(rawRoot);
    } catch {
      // Keep rawRoot if path does not exist on disk yet.
    }
    return this.contexts.get(root)?.context;
  }

  async runInWorkspace<T>(
    ctx: WorkspaceContext,
    work: (prepared: WorkspaceContext) => Promise<T>,
    {
      signal,
      isDomainRegistration = false,
      mode = "read",
      onSync,
    }: { signal?: AbortSignal; isDomainRegistration?: boolean; mode?: "read" | "write"; onSync?: () => void } = {},
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Septum server is shutting down");
    if (this.activeRequests >= RESOURCE_LIMITS.maxQueuePending) {
      throw new WorkspaceBusyError(`Server is busy: workspace request limit (${RESOURCE_LIMITS.maxQueuePending}) exceeded.`);
    }
    this.activeRequests++;
    try {
      await waitForSharedWork(ctx.ready, signal);
      signal?.throwIfAborted();
      const registrationBeforeDiscovery =
        isDomainRegistration && Object.keys(ctx.config.domains).length === 0 && ctx.repo.getAllDomains().length === 0;
      try {
        if (!registrationBeforeDiscovery) {
          onSync?.();
          await waitForSharedWork(ctx.watcher.flush(false), signal);
        }
      } catch (error) {
        signal?.throwIfAborted();
        if (!isDomainRegistration || !(error instanceof DomainRootConflictError)) throw error;
      }
      // Flush can enqueue work on the same lane. Reload and use policy only after
      // admission, so another queued request cannot change the policy mid-call.
      const runQueued = mode === "write" || isDomainRegistration
        ? ctx.queue.runWrite.bind(ctx.queue)
        : ctx.queue.runRead.bind(ctx.queue);
      return await runQueued(async () => {
        if (this.closed) throw new Error("Septum server is shutting down");
        const syncError = ctx.repo.getMeta("sync_error");
        if (syncError && !(isDomainRegistration && ctx.repo.getMeta("sync_error_code") === "DOMAIN_ROOT_CONFLICT")) {
          throw new Error(`Workspace index synchronization failed: ${syncError}`);
        }
        ctx.config = ConfigLoader.load(undefined, ctx.root);
        if (!isDomainRegistration) ctx.pipeline.assertDomainOwnership(ctx.config, ctx.root);
        ctx.evaluator.getResolver().setRepository(ctx.repo);
        return work(ctx);
      }, signal);
    } finally {
      this.activeRequests--;
    }
  }

  acquire(rawRoot: string, options: { deferDiscovery?: boolean } = {}): WorkspaceLease {
    if (this.closed) throw new Error('Septum server is shutting down');
    const root = realpathSync(rawRoot);
    let entry = this.contexts.get(root);
    if (!entry) {
      if (this.contexts.size >= RESOURCE_LIMITS.workspaces) {
        const idle = [...this.contexts.values()].filter(value => !value.leases && !value.initializing && !value.context.watcher.isBusy).sort((a,b) => a.lastUsed - b.lastUsed)[0];
        if (!idle) throw new Error('Workspace resource limit reached: all workspace slots are busy. Retry after active requests finish.');
        this.dispose(idle);
      }
      const config = ConfigLoader.load(undefined, root);
      const db = new SeptumDatabase(resolveDatabasePath(root, config.settings.db_path));
      try {
        const repo = new SeptumRepository(db.raw);
        const pipeline = new IngestionPipeline(repo, root);
        const evaluator = new BoundaryEvaluator(repo, new ModuleResolver(root, repo));
        const abort = new AbortController();
        const queue = new ReadWriteWorkQueue();
        const ready = queue.runWrite(async () => {
          abort.signal.throwIfAborted();
          // An explicit first registration chooses ownership before discovery.
          if (options.deferDiscovery && Object.keys(config.domains).length === 0 && repo.getAllDomains().length === 0) return;
          try { await pipeline.run(config, {verifyContent:true,signal:abort.signal}); }
          catch (error) {
            // Keep a conflicting legacy workspace open for explicit domain repair.
            // Its index remains in error and cannot serve normal tool requests.
            if (!(error instanceof DomainRootConflictError)) throw error;
          }
        });
        const watcher = new WorkspaceWatcher(root, repo, pipeline, ready, queue, this.budget, () => ConfigLoader.load(undefined, root));
        entry = {context:{root,config,db,repo,evaluator,pipeline,ready,watcher,queue},leases:0,lastUsed:this.now(),initializing:true,abort};
        this.contexts.set(root, entry);
        const initialized = entry;
        void ready.then(() => { initialized.initializing = false; }, () => { initialized.initializing = false; this.dispose(initialized); });
      } catch (error) { db.close(); throw error; }
    }
    this.lastRoot = root;
    entry.leases++; entry.lastUsed = this.now();
    const leased = entry; let released = false;
    return {context: entry.context, release: () => { if (!released) { released=true; leased.leases--; leased.lastUsed=this.now(); } }};
  }

  private dispose(entry: Entry): Promise<void> {
    if (entry.disposal) return entry.disposal;
    if (this.contexts.get(entry.context.root) === entry) this.contexts.delete(entry.context.root);
    entry.abort.abort();
    const idle = !entry.leases && !entry.initializing && !entry.context.watcher.isBusy;
    const stop = entry.context.watcher.close();
    // Eviction of an idle context closes its database before admitting another.
    if (idle) entry.context.db.close();
    const disposal = stop.then(async () => { if (!idle) { await entry.context.queue.drain(); entry.context.db.close(); } });
    entry.disposal = disposal;
    this.disposals.add(disposal);
    void disposal.finally(() => this.disposals.delete(disposal)).catch(error =>
      SeptumTelemetry.recordSystemEvent({
        level: 'WARN',
        component: 'workspace_manager',
        event: 'workspace_disposal_failed',
        fields: { message: String(error).slice(0, 256) },
        workspaceRoot: entry.context.root,
      })
    );
    return disposal;
  }

  async expireIdle(): Promise<void> {
    const expired = [...this.contexts.values()].filter(entry => !entry.leases && !entry.initializing && !entry.context.watcher.isBusy && this.now() - entry.lastUsed >= RESOURCE_LIMITS.workspaceIdleMs);
    await Promise.all(expired.map(entry => this.dispose(entry)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true; clearInterval(this.idleTimer);
    const pending = [...this.contexts.values()].map(entry => this.dispose(entry));
    this.closing = Promise.allSettled([...pending, ...this.disposals]).then(results => {
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    });
    return this.closing;
  }
}
