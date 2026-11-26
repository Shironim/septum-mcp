import { RESOURCE_LIMITS } from "../../src/core/resources/limits.ts";
import { waitForSharedWork } from "../../src/core/resources/work-queue.ts";
import {describe,expect,it} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceManager,resolveServerWorkspace} from '../../src/mcp/workspace-manager.ts';
import {resolveOptionalInitialWorkspace} from '../../src/mcp/server.ts';

function fixture(){const parent=mkdtempSync(join(tmpdir(),'septum-context-'));const roots=Array.from({length:6},(_,i)=>{const root=join(parent,String(i));mkdirSync(join(root,'src'),{recursive:true});writeFileSync(join(root,'package.json'),'{"name":"fixture"}');writeFileSync(join(root,'src/a.ts'),'export function a() {}');return root;});return{parent,roots};}
describe('workspace admission and leases',()=>{
 it('bounds live contexts, protects busy leases, and reopens evicted workspaces',async()=>{
  const f=fixture(),manager=new WorkspaceManager();try{const leases=f.roots.slice(0,4).map(root=>manager.acquire(root));await Promise.all(leases.map(l=>l.context.ready));expect(()=>manager.acquire(f.roots[4])).toThrow('busy');leases[0].release();const fifth=manager.acquire(f.roots[4]);await fifth.context.ready;expect(manager.size).toBe(4);fifth.release();for(const lease of leases)lease.release();const reopened=manager.acquire(f.roots[0]);await reopened.context.ready;expect(reopened.context.repo.getFileByPath('src/a.ts')).not.toBeNull();reopened.release();}finally{await manager.close();rmSync(f.parent,{recursive:true,force:true});}expect(manager.size).toBe(0);expect(manager.watchCount).toBe(0);
 });
 it('expires idle contexts and preserves SQLite data',async()=>{
  const f=fixture();let now=0;const manager=new WorkspaceManager(()=>now);try{const lease=manager.acquire(f.roots[0]);await lease.context.ready;lease.release();now=600001;await manager.expireIdle();expect(manager.size).toBe(0);const again=manager.acquire(f.roots[0]);await again.context.ready;expect(again.context.repo.getFileByPath('src/a.ts')).not.toBeNull();again.release();}finally{await manager.close();rmSync(f.parent,{recursive:true,force:true});}
 });
 it('keeps explicit unmarked directories exact, canonicalizes aliases and rejects broad roots',()=>{
  const f=fixture();try{const plain=join(f.parent,'plain');mkdirSync(plain);const alias=join(f.parent,'alias');symlinkSync(plain,alias);expect(resolveServerWorkspace({workspacePath:plain})).toBe(plain);expect(resolveServerWorkspace({workspacePath:alias})).toBe(plain);expect(()=>resolveServerWorkspace({workspacePath:homedir()})).toThrow();expect(()=>resolveServerWorkspace({workspacePath:'/'})).toThrow();expect(()=>resolveServerWorkspace({initial:true,cwd:plain})).toThrow('SEPTUM_WORKSPACE_ROOT');expect(resolveOptionalInitialWorkspace({cwd:plain})).toBeUndefined();expect(resolveOptionalInitialWorkspace({cwd:homedir()})).toBeUndefined();expect(resolveOptionalInitialWorkspace({cwd:f.roots[0]})).toBe(f.roots[0]);}finally{rmSync(f.parent,{recursive:true,force:true});}
 });
});

it("a cancelled request detaches while another request can finish waiting for the same workspace work", async () => {
  const controller = new AbortController();
  const shared = Promise.withResolvers<string>();
  const first = waitForSharedWork(shared.promise, controller.signal);
  const second = waitForSharedWork(shared.promise, new AbortController().signal);
  controller.abort(new Error("client cancelled"));
  await expect(first).rejects.toThrow("client cancelled");
  shared.resolve("index ready");
  await expect(second).resolves.toBe("index ready");
});

it("limits requests waiting for workspace readiness and recovers admission after cancellation", async () => {
  const f = fixture();
  const manager = new WorkspaceManager();
  const lease = manager.acquire(f.roots[0]!);
  const readiness = Promise.withResolvers<void>();
  const waitingContext = { ...lease.context, ready: readiness.promise };
  const cancellation = new AbortController();
  const waiting = Array.from({ length: RESOURCE_LIMITS.maxQueuePending }, () =>
    manager.runInWorkspace(waitingContext, async () => {}, { signal: cancellation.signal }));
  const settled = Promise.allSettled(waiting);
  try {
    await expect(manager.runInWorkspace(waitingContext, async () => {})).rejects.toThrow("workspace request limit");
    cancellation.abort();
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    await expect(manager.runInWorkspace(lease.context, async () => "admitted")).resolves.toBe("admitted");
  } finally {
    cancellation.abort();
    await settled;
    readiness.resolve();
    lease.release();
    await manager.close();
    rmSync(f.parent, { recursive: true, force: true });
  }
});
