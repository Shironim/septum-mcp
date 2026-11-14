import { expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../../src/core/config/loader.ts';
import { SeptumDatabase } from '../../src/core/database/client.ts';
import { SeptumRepository } from '../../src/core/database/repository.ts';
import { IngestionPipeline } from '../../src/core/ingestion/pipeline.ts';
import { handleGetDomainCatalog } from '../../src/mcp/tools/get-domain-catalog.ts';
import { handleGetSymbolImpact } from '../../src/mcp/tools/get-symbol-impact.ts';
import { handleCheckBoundary } from '../../src/mcp/tools/check-boundary.ts';
import { BoundaryEvaluator } from '../../src/core/boundary/evaluator.ts';
import { ModuleResolver } from '../../src/core/resolver/module-resolver.ts';
import { McpCliSemanticExtractor } from '../../src/core/parser/extractors/mcp-cli-semantic.ts';
async function fixture(run: (root: string, repo: SeptumRepository, config: ReturnType<typeof ConfigLoader.getDefaultConfig>, put: (p:string,s:string)=>void)=>Promise<void>) {
 const root=mkdtempSync(join(tmpdir(),'septum-output-')); const db=new SeptumDatabase(':memory:');
 const config=ConfigLoader.getDefaultConfig();config.domains={app:{root:'src/app',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}}};
 const put=(p:string,s:string)=>{mkdirSync(dirname(join(root,p)),{recursive:true});writeFileSync(join(root,p),s);};
 try {await run(root,new SeptumRepository(db.raw),config,put);}finally{db.close();rmSync(root,{recursive:true,force:true});}
}
test('catalog pages preserve every file with explicit offsets',()=>fixture(async(root,repo,config,put)=>{
 for(let i=0;i<12;i++)put(`src/app/f${i}.ts`,`export const value${i} = ${i};`);
 await new IngestionPipeline(repo,root).run(config);
 const seen=new Set<string>();let offset=0;
 do {const p=JSON.parse(handleGetDomainCatalog(repo,config,{domain:'app',detail_level:'full',file_offset:offset,file_limit:3},root).content[0]!.text);
 expect(p.files.length).toBeLessThanOrEqual(3);for(const file of p.files){expect(seen.has(file.path)).toBe(false);seen.add(file.path);}
 offset=p.pagination?.next_file_offset ?? -1;}while(offset>=0);
 expect(seen.size).toBe(12);
}));
test('impact reports import-bound alias calls and excludes comments and shadowed identifiers',()=>fixture(async(root,repo,config,put)=>{
 put('src/app/target.ts','export function submit() { return 1; }\n');
 put('src/app/caller.ts',`import {submit as send} from './target';\n// send();\nexport function caller() { return send(); }\nexport function shadow(send: () => number) { return send(); }\n`);
 put('src/app/import-only.ts',`import {submit} from './target';\nexport const idle = 1;`);
 await new IngestionPipeline(repo,root).run(config);
 const p=JSON.parse(handleGetSymbolImpact(repo,config,{symbol:'submit'},root).content[0]!.text);
 expect(p.call_sites).toEqual([{file:'src/app/caller.ts',line:3,caller:'caller',kind:'call',domain:'app'}]);
 expect(p.inbound_callers_complete).toBe(false);
}));
test('large declarations stay outside navigation output',()=>fixture(async(root,repo,config,put)=>{
 put('src/app/large.ts','export interface Large {\n'+Array.from({length:1000},(_,i)=>`field${i}: { description: string; value: number };`).join('\n')+'\n}');
 await new IngestionPipeline(repo,root).run(config);
 const p=JSON.parse(handleGetDomainCatalog(repo,config,{domain:'app',detail_level:'full'},root).content[0]!.text);
 expect(p.schema).toBe('navigation/v1');expect(p.files[0].anchor).toBe('Large');
 expect(p.files[0].symbols).toBeUndefined();expect(p.files[0].declarations).toBeUndefined();expect(p.pagination).toBeUndefined();
 expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThan(32768);
}));
test('MCP slice does not promote a type-only parameter import to an engine service',()=>fixture(async(root,repo,config,put)=>{
 put('src/mcp/server.ts','const TOOL_SCHEMAS = { fixture: {} };');
 put('src/mcp/tools/fixture.ts',`import type { Pipeline } from '../../app/pipeline';\nexport function handleFixture(value: Pipeline) { return 1; }`);
 put('src/app/pipeline.ts','export class Pipeline { run() {} }');
 const slices=new McpCliSemanticExtractor().extractSlices(root);
 expect(slices).toHaveLength(1);
 expect(JSON.parse(slices[0]!.execution_chain_json).some((node:any)=>node.stage==='service'&&node.symbol==='Pipeline')).toBe(false);
}));
test('boundary explains and bounds uncovered-target evidence without approving it',()=>fixture(async(root,repo,config,put)=>{
 for(let i=0;i<15;i++){put(`src/shared/f${i}.ts`,`export const value${i} = 1;`);put(`src/app/f${i}.ts`,`import {value${i}} from '../shared/f${i}';\nexport const output${i}=value${i};`);}
 await new IngestionPipeline(repo,root).run(config);
 const p=JSON.parse((await handleCheckBoundary(new BoundaryEvaluator(repo,new ModuleResolver(root,repo)),config,{scope:'all'},repo,root)).content[0]!.text);
 expect(p.status).toBe('unknown');expect(p.relationships.length).toBe(10);expect(p.diagnostic_accounting).toEqual({total:15,returned:10,omitted:5});expect(p.incomplete_reasons.target_not_fully_indexed).toBe(15);
}));

test('navigation avoids declaration catalogs and returns a small scope without paging',()=>fixture(async(root,repo,config,put)=>{
 for(let i=0;i<12;i++)put(`src/app/f${i}.ts`,`export function action${i}(value: string): string { return value; }`);
 await new IngestionPipeline(repo,root).run(config);
 const catalog=spyOn(repo,'getDomainCatalog').mockImplementation(()=>{throw new Error('declaration catalog must not be built');});
 const symbols=spyOn(repo,'getSymbolsByFileId').mockImplementation(()=>{throw new Error('full symbols must not be loaded');});
 try {
  const p=JSON.parse(handleGetDomainCatalog(repo,config,{domain:'app',detail_level:'full'},root).content[0]!.text);
  expect(p.files).toHaveLength(12);expect(p.pagination).toBeUndefined();expect(p.parser_capabilities).toBeUndefined();expect(p.relationships).toBeUndefined();
  expect(p.files.every((file:any)=>!('symbols' in file)&&!('declarations' in file)&&!('signature' in file))).toBe(true);
  expect(p.next[0].tool).toBe('septum_symbol');expect(p.next[0].args.query).toMatch(/^action\d+$/);
 } finally {catalog.mockRestore();symbols.mockRestore();}
}));

test('workspace maps aggregate domain imports; focused maps retain incoming and outgoing paths',()=>fixture(async(root,repo,config,put)=>{
 config.domains.shared={root:'src/shared',allowed_dependencies:[],forbidden_dependencies:[],archetypes:{}};
 put('src/app/use.ts',`import {shared} from '../shared/item';\nexport function use() { return shared; }`);
 put('src/shared/item.ts','export const shared = 1;');
 await new IngestionPipeline(repo,root).run(config);
 const workspace=JSON.parse(handleGetDomainCatalog(repo,config,{},root).content[0]!.text);
 expect(workspace.dependencies).toEqual([{from:'app',to:'shared',relation:'imports',count:1}]);expect(workspace.files).toEqual([]);
 const focus=JSON.parse(handleGetDomainCatalog(repo,config,{domain:'shared',file_filter:'item.ts'},root).content[0]!.text);
 expect(focus.dependencies).toEqual([{from:'src/app/use.ts',to:'src/shared/item.ts',relation:'imports',count:1}]);
 expect(focus.evidence).toBeUndefined();
 const detailed=JSON.parse(handleGetDomainCatalog(repo,config,{domain:'app',file_filter:'use.ts',include_evidence:true},root).content[0]!.text);
 expect(detailed.evidence).toHaveLength(1);expect(detailed.evidence[0].source.file).toBe('src/app/use.ts');
 expect(()=>handleGetDomainCatalog(repo,config,{domain:'app',include_evidence:true},root)).toThrow('exactly one');
}));
