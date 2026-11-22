import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,readFile,writeFile,readdir,rm,rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitState,migrateLegacy } from '../scripts/lib/controlled-write.mjs';
import { encode,loadProject,projectProjection,validateState } from '../scripts/lib/state.mjs';
import { sample } from './fixtures.mjs';

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'steven-controlled-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'.steven/state'),{recursive:true});await writeFile(path.join(root,'PRD.md'),'基线');
 const state=sample();await writeFile(path.join(root,'.steven/state/authorized.json'),encode(state));await writeFile(path.join(root,'.steven/project.json'),encode(projectProjection(state,{customNavigation:'keep'})));
 const loaded=await loadProject(root);
 const nextState={...state,revision:1,lastOperation:{operationId:'op1',status:'completed',kind:'local-test'}};
 return {root,nextState,operationId:'op1',expected:{revision:0,stateDigest:loaded.stateDigest,projectDigest:loaded.projectDigest}};
}
async function assertClean(root){assert.deepEqual((await readdir(path.join(root,'.steven/state'))).sort(),['authorized.json']);assert.deepEqual((await readdir(path.join(root,'.steven'))).sort(),['project.json','state']);}

test('真实本地模块写入、完整回读与原操作重入，不重复增加修订',async t=>{
 const f=await fixture(t);const first=await commitState(f);assert.equal(first.ok,true,JSON.stringify(first));
 const s=await loadProject(f.root);assert.equal(s.state.revision,1);assert.equal(s.project.customNavigation,'keep');
 const second=await commitState(f);assert.equal(second.ok,true,JSON.stringify(second));assert.equal(second.code,'RESUMED');assert.equal((await loadProject(f.root)).state.revision,1);await assertClean(f.root);
});
test('显式空的未解决集合规范化后，原请求仍可安全重入',async t=>{
 const f=await fixture(t);f.nextState.lastOperation.unresolved={};
 assert.equal((await commitState(f)).ok,true);
 assert.equal((await loadProject(f.root)).state.lastOperation.unresolved,undefined);
 assert.equal((await commitState(f)).code,'RESUMED');
});
test('不同阶段故障注入：原子写前不变；权威后部分写入可沿原操作恢复',async t=>{
 for(const boundary of ['locked','before-rename:.steven/state/authorized.json','after-rename:.steven/state/authorized.json','authority-written','before-rename:.steven/project.json','after-rename:.steven/project.json','projection-written']){
  const f=await fixture(t);const r=await commitState({...f,checkpoint:async phase=>{if(phase===boundary)throw new Error('injected')}});
  assert.equal(r.ok,false,boundary);
  const after=await loadProject(f.root);
  if(['locked','before-rename:.steven/state/authorized.json'].includes(boundary)){assert.equal(after.state.revision,0);assert.equal(r.committed,false);}
  else{assert.equal(after.state.revision,1);assert.equal(r.committed,true);}
  await assertClean(f.root);
  const resumed=await commitState(f);assert.equal(resumed.ok,true,JSON.stringify(resumed));assert.equal((await loadProject(f.root)).project.revision,1);await assertClean(f.root);
 }
});
test('锁并发排他，不偷老锁；当前持有者收尾只删除自己的锁',async t=>{
 const f=await fixture(t);let entered,release;const gate=new Promise(r=>release=r);const signal=new Promise(r=>entered=r);
 const first=commitState({...f,checkpoint:async phase=>{if(phase==='locked'){entered();await gate;}}});await signal;
 const second=await commitState({...f,operationId:'op2'});assert.equal(second.code,'LOCKED');release();assert.equal((await first).ok,true);await assertClean(f.root);
 await writeFile(path.join(f.root,'.steven/state/write.lock'),encode({nonce:'other',createdAt:'1900-01-01'}));
 assert.equal((await commitState(f)).code,'LOCKED');assert.match(await readFile(path.join(f.root,'.steven/state/write.lock'),'utf8'),/other/);
});
test('陈旧子结果、复用身份换目标、非协作内容变化均拒绝',async t=>{
 const f=await fixture(t);assert.equal((await commitState(f)).ok,true);
 const stale=await commitState({...f,operationId:'op2',nextState:{...f.nextState,lastOperation:{operationId:'op2',status:'completed'}}});assert.equal(stale.code,'STALE_BASELINE');
 const conflict=await commitState({...f,nextState:{...f.nextState,extra:'new intent'}});assert.equal(conflict.code,'OPERATION_CONFLICT');
 const f2=await fixture(t);const bad=await commitState({...f2,checkpoint:async phase=>{if(phase==='before-rename:.steven/state/authorized.json'){const p=path.join(f2.root,'.steven/state/authorized.json');const v=JSON.parse(await readFile(p));v.other='concurrent';await writeFile(p,encode(v));}}});
 assert.equal(bad.code,'STALE_BASELINE');assert.equal((await loadProject(f2.root)).state.other,'concurrent');await assertClean(f2.root);
});
test('提交前排他锁被替换时拒绝写入，并不清理别人的锁',async t=>{
 for(const boundary of ['locked','before-rename:.steven/state/authorized.json','before-rename:.steven/project.json']){
  const f=await fixture(t);const lock=path.join(f.root,'.steven/state/write.lock');
  const result=await commitState({...f,checkpoint:async phase=>{if(phase===boundary)await writeFile(lock,encode({nonce:'different-writer',operationId:'other'}))}});
  assert.equal(result.code,'LOCK_LOST');assert.match(await readFile(lock,'utf8'),/different-writer/);
  assert.equal(result.committed,boundary==='before-rename:.steven/project.json');
  assert.equal((await loadProject(f.root)).state.revision,boundary==='before-rename:.steven/project.json'?1:0);
 }
});
test('锁被同内容新文件替换后仍保留现场，不仅凭 nonce 清理',async t=>{
 const f=await fixture(t);const lock=path.join(f.root,'.steven/state/write.lock');let copied;
 const result=await commitState({...f,checkpoint:async phase=>{if(phase==='locked'){
  copied=await readFile(lock,'utf8');await rename(lock,lock+'.displaced');await writeFile(lock,copied);
 }}});
 assert.equal(result.code,'LOCK_LOST');assert.equal(result.committed,false);
 assert.equal(await readFile(lock,'utf8'),copied);assert.equal((await loadProject(f.root)).state.revision,0);
});
test('有精确批准的定稿纯路径迁移保持字节与身份，未批准拒绝',async t=>{
 const f=await fixture(t);await mkdir(path.join(f.root,'standard'));await writeFile(path.join(f.root,'standard/PRD.md'),'基线');f.nextState.prds.p1.path='standard/PRD.md';
 assert.equal((await commitState(f)).code,'FROZEN_PATH');
 f.nextState.lastOperation.pathMoves=[{prdId:'p1',from:'PRD.md',to:'standard/PRD.md',approvalReference:'user:move-only'}];
 assert.equal((await commitState(f)).ok,true);await rm(path.join(f.root,'PRD.md'));
 assert.equal((await loadProject(f.root)).valid,true);assert.equal(await readFile(path.join(f.root,'standard/PRD.md'),'utf8'),'基线');
});
test('投影被他人改变时不覆盖；保留已经写好的权威和冲突证据',async t=>{
 const f=await fixture(t);await commitState({...f,checkpoint:async phase=>{if(phase==='authority-written')throw new Error('stop')}});
 const p=path.join(f.root,'.steven/project.json');const old=JSON.parse(await readFile(p));old.userChange='keep';await writeFile(p,encode(old));
 const r=await commitState(f);assert.equal(r.code,'PROJECTION_CONFLICT');assert.equal(r.committed,true);assert.equal(JSON.parse(await readFile(p)).userChange,'keep');
});
test('冻结记录不可改摘要/删身份；缺少远端投影的生效声明被实际校验拒绝',async t=>{
 for(const mutation of [s=>{delete s.prds.p1;s.iterations.v1.prdIds=[];s.iterations.v1.currentPrdId=null;s.projectDemands[0].prdId=null;},s=>{s.prds.p1.contentDigest='sha256:'+'0'.repeat(64);s.prds.p1.evidence.remoteDigest=s.prds.p1.contentDigest;},s=>{delete s.prds.p1.evidence.remoteCommit;}]){
  const f=await fixture(t);mutation(f.nextState);const r=await commitState(f);assert.equal(r.ok,false);assert.equal(r.committed,false);assert.equal((await loadProject(f.root)).state.revision,0);
 }
});
test('未完操作不能被无关新操作抹掉；本地写入不伪造外部回执',async t=>{
 const f=await fixture(t);f.nextState.lastOperation.status='unknown';f.nextState.lastOperation.externalReceipt={status:'unknown',objectId:'original'};
 assert.equal((await commitState(f)).ok,true);const now=await loadProject(f.root);
 assert.equal(validateState(now.state,now.project,{action:'develop',iterationId:'v1'}).allowed,false);
 const next={...now.state,revision:2,lastOperation:{operationId:'op2',status:'completed'}};
 const r=await commitState({root:f.root,nextState:next,operationId:'op2',expected:{revision:1,stateDigest:now.stateDigest,projectDigest:now.projectDigest}});
 assert.equal(r.code,'OPERATION_UNRESOLVED');assert.equal((await loadProject(f.root)).state.lastOperation.externalReceipt.objectId,'original');
});
test('承接身份不是解决证据：多次更新仍保存未知回执，逐项核实后才解除',async t=>{
 const f=await fixture(t);f.nextState.lastOperation={operationId:'op1',status:'unknown',affectedIterationIds:['v1'],externalReceipt:{status:'unknown',objectId:'B1'}};
 assert.equal((await commitState(f)).ok,true);
 async function request(id,extra={}){const now=await loadProject(f.root);return {root:f.root,operationId:id,expected:{revision:now.state.revision,stateDigest:now.stateDigest,projectDigest:now.projectDigest},nextState:{...now.state,revision:now.state.revision+1,lastOperation:{operationId:id,status:'completed',previousOperationId:now.state.lastOperation.operationId,...extra}}};}
 const r2=await request('op2');assert.equal((await commitState(r2)).ok,true);
 let now=await loadProject(f.root,{action:'develop',iterationId:'v1'});
 assert.equal(now.allowed,false);assert.equal(now.state.lastOperation.unresolved.op1.externalReceipt.objectId,'B1');
 assert.equal((await commitState(r2)).code,'RESUMED');
 const r3=await request('op3',{status:'unknown',affectedIterationIds:['v1'],externalReceipt:{status:'unknown',objectId:'B2'}});
 assert.equal((await commitState(r3)).ok,true);
 const r4=await request('op4');
 const interrupted=await commitState({...r4,checkpoint:async phase=>{if(phase==='authority-written')throw Error('stop');}});
 assert.equal(interrupted.committed,true);assert.equal((await commitState(r4)).code,'RESUMED');
 now=await loadProject(f.root);assert.deepEqual(Object.keys(now.state.lastOperation.unresolved).sort(),['op1','op3']);
 const tampered=await request('tampered',{unresolved:{}});assert.equal((await commitState(tampered)).ok,false);
 for(const change of [op=>{op.externalReceipt.objectId='substitute';},op=>{op.affectedIterationIds=[];}]){
  const changed=structuredClone(now.state.lastOperation.unresolved);change(changed.op1);
  assert.equal((await commitState(await request('changed',{unresolved:changed}))).code,'OPERATION_EVIDENCE_CHANGED');
 }
 assert.equal((await commitState(await request('op1'))).code,'OPERATION_CONFLICT');
 for(const refs of [{missing:'readback:missing'},{op1:''}])assert.equal((await commitState(await request('invalid',{resolvedOperationReferences:refs}))).ok,false);
 assert.equal((await commitState(await request('op5',{resolvedOperationReferences:{op1:'evidence:B1-readback'}}))).ok,true);
 now=await loadProject(f.root,{action:'develop',iterationId:'v1'});assert.equal(now.allowed,false);assert.deepEqual(Object.keys(now.state.lastOperation.unresolved),['op3']);
 assert.equal((await commitState(await request('op6',{resolvedOperationReferences:{op3:'evidence:B2-readback'}}))).ok,true);
 now=await loadProject(f.root,{action:'develop',iterationId:'v1'});assert.equal(now.allowed,true);assert.equal(now.state.lastOperation.unresolved,undefined);await assertClean(f.root);
});
test('带未解决回执的无关更新，在每个本地故障点重入都不丢证据',async t=>{
 for(const boundary of ['locked','before-rename:.steven/state/authorized.json','after-rename:.steven/state/authorized.json','authority-written','before-rename:.steven/project.json','after-rename:.steven/project.json','projection-written']){
  const f=await fixture(t);f.nextState.lastOperation={operationId:'op1',status:'unknown',affectedIterationIds:['v1'],externalReceipt:{objectId:'original',status:'unknown'}};
  assert.equal((await commitState(f)).ok,true);
  const now=await loadProject(f.root);const next={root:f.root,operationId:'op2',expected:{revision:1,stateDigest:now.stateDigest,projectDigest:now.projectDigest},nextState:{...now.state,revision:2,lastOperation:{operationId:'op2',status:'completed',previousOperationId:'op1'}}};
  assert.equal((await commitState({...next,checkpoint:async phase=>{if(phase===boundary)throw Error('stop');}})).ok,false);
  assert.equal((await commitState(next)).ok,true,boundary);
  const after=await loadProject(f.root,{action:'develop',iterationId:'v1'});assert.equal(after.allowed,false,boundary);assert.equal(after.state.lastOperation.unresolved.op1.externalReceipt.objectId,'original');await assertClean(f.root);
 }
});

test('补记旧待办的版本归属，保留原回执并只阻断所属迭代',async t=>{
 const f=await fixture(t);
 f.nextState.iterations.legacy={baselineIterationId:null,prdIds:[],currentPrdId:null,draftPrdId:null,development:{status:'not-started'}};
 f.nextState.lastOperation={operationId:'op1',status:'partial',externalReceipt:{status:'unknown',objectId:'original'}};
 assert.equal((await commitState(f)).ok,true);
 const before=await loadProject(f.root,{action:'develop',iterationId:'v1'});
 assert.equal(before.allowed,false);
 const expected={revision:1,stateDigest:before.stateDigest,projectDigest:before.projectDigest};
 const request=lastOperation=>({root:f.root,expected,operationId:'bind',nextState:{...before.state,revision:2,
   lastOperation:{operationId:'bind',previousOperationId:'op1',status:'completed',...lastOperation}}});
 const binding={affectedIterationIds:['legacy'],evidenceReference:'evidence:original-environment'};
 for(const operationScopeAssignments of [{missing:binding},{op1:{...binding,evidenceReference:''}},{op1:{...binding,affectedIterationIds:[]}},{op1:{...binding,affectedIterationIds:['missing']}}]){
  const rejected=await commitState(request({operationScopeAssignments}));
  assert.equal(rejected.ok,false);assert.equal(rejected.committed,false);
 }
 const conflict=await commitState(request({operationScopeAssignments:{op1:binding},resolvedOperationReferences:{op1:'readback:same'}}));
 assert.equal(conflict.code,'OPERATION_SCOPE');
 const r=request({operationScopeAssignments:{op1:binding}});
 const interrupted=await commitState({...r,checkpoint:async phase=>{if(phase==='authority-written')throw Error('stop');}});
 assert.equal(interrupted.committed,true);
 assert.equal((await commitState(r)).code,'RESUMED');
 const after=await loadProject(f.root,{action:'develop',iterationId:'v1'});
 assert.equal(after.allowed,true);
 assert.equal(validateState(after.state,after.project,{action:'develop',iterationId:'legacy'}).issues.some(i=>i.code==='OPERATION_PENDING'),true);
 const {unresolved,operationScopeAssignments,resolvedOperationReferences,...original}=before.state.lastOperation;
 assert.deepEqual(after.state.lastOperation.unresolved.op1,{...original,affectedIterationIds:['legacy'],scopeEvidenceReference:binding.evidenceReference});
 const rewrite=await commitState({...r,operationId:'redirect',expected:{revision:2,stateDigest:after.stateDigest,projectDigest:after.projectDigest},
   nextState:{...after.state,revision:3,lastOperation:{operationId:'redirect',status:'completed',operationScopeAssignments:{op1:{...binding,affectedIterationIds:['v1']}}}}});
 assert.equal(rewrite.code,'OPERATION_SCOPE');
 await assertClean(f.root);
});
test('旧格式迁移不猜批准与范围；保留未知字段且只产生候选，原输入不动',async()=>{
 const s=sample();const legacy={schemaVersion:'2',projectId:'demo',sourceDemands:s.sourceDemands,projectDemands:s.projectDemands,prd:{current:'PRD.md',lifecycle:'定稿'},custom:{preserve:true}};
 const project={schemaVersion:'2',projectId:'demo',prd:legacy.prd};const before=encode(legacy);
 assert.equal(migrateLegacy(legacy,project,null).code,'MIGRATION_EVIDENCE_REQUIRED');
 const mapping={approvalReference:'user:migrate',operationId:'migrate1',iterations:s.iterations,prds:s.prds,currentIterationId:'v1',demands:{d1:{iterationId:'v1',prdId:'p1',business:{status:'已实现'}}}};
 const r=migrateLegacy(legacy,project,mapping);assert.equal(r.ok,true);assert.equal(r.state.custom.preserve,true);assert.equal(r.state.projectDemands[0].business.status,'开发中');assert.equal(encode(legacy),before);
 mapping.demands={};assert.equal(migrateLegacy(legacy,project,mapping).code,'MIGRATION_SCOPE_MISMATCH');
 mapping.demands={d1:null};assert.equal(migrateLegacy(legacy,project,mapping).code,'MIGRATION_MAPPING_INVALID');
 for(const v of [null,[],true,1,'x'])assert.equal(migrateLegacy({...legacy,projectDemands:[v]},project,mapping).code,'MIGRATION_SOURCE_INVALID');
});
test('隔离旧状态迁移中断恢复与字节回退，可验证而不触碰日常状态',async t=>{
 const f=await fixture(t);const s=sample();
 const legacy={schemaVersion:'2',projectId:'demo',sourceDemands:s.sourceDemands,projectDemands:s.projectDemands,prd:{current:'PRD.md',lifecycle:'定稿'}};
 const p={schemaVersion:'2',projectId:'demo',prd:legacy.prd};
 const statePath=path.join(f.root,'.steven/state/authorized.json'),projectPath=path.join(f.root,'.steven/project.json');
 const backup={state:encode(legacy),project:encode(p)};await writeFile(statePath,backup.state);await writeFile(projectPath,backup.project);
 const before=await loadProject(f.root);
 const migrated=migrateLegacy(legacy,p,{approvalReference:'user:migrate',operationId:'migration',iterations:s.iterations,prds:s.prds,currentIterationId:'v1',demands:{d1:{iterationId:'v1',prdId:'p1'}}});
 const request={root:f.root,nextState:migrated.state,operationId:'migration',expected:{revision:0,stateDigest:before.stateDigest,projectDigest:before.projectDigest}};
 const interrupted=await commitState({...request,checkpoint:async phase=>{if(phase==='authority-written')throw new Error('interrupt')}});
 assert.equal(interrupted.committed,true);
 // A fresh invocation must recover a mixed schema projection, not reject its own partial write.
 const recovered=await commitState(request);assert.equal(recovered.ok,true,JSON.stringify(recovered));
 await writeFile(statePath,backup.state);await writeFile(projectPath,backup.project);
 assert.equal((await loadProject(f.root)).valid,true);assert.equal(await readFile(statePath,'utf8'),backup.state);
});

test('旧格式定稿和历史关联不能被迁移映射删除或改写，直接提交也拒绝',async t=>{
 const f=await fixture(t),s=sample();
 const legacy={schemaVersion:'2',projectId:'demo',sourceDemands:s.sourceDemands,projectDemands:s.projectDemands,
  prd:{id:'p1',current:'PRD.md',lifecycle:'定稿',contentDigest:s.prds.p1.contentDigest}};
 const project={schemaVersion:'2',projectId:'demo',prd:structuredClone(legacy.prd)};
 const statePath=path.join(f.root,'.steven/state/authorized.json'),projectPath=path.join(f.root,'.steven/project.json');
 await writeFile(statePath,encode(legacy));await writeFile(projectPath,encode(project));
 const before=await loadProject(f.root);
 const mapping={approvalReference:'user:migrate',operationId:'migration',iterations:s.iterations,prds:s.prds,currentIterationId:'v1',demands:{d1:{iterationId:'v1',prdId:'p1'}}};
 const good=migrateLegacy(legacy,project,mapping);assert.equal(good.ok,true);
 for(const change of [
  m=>{m.prds={};m.iterations.v1.prdIds=[];m.iterations.v1.currentPrdId=null;m.demands.d1.prdId=null;},
  m=>{m.prds.p2=m.prds.p1;delete m.prds.p1;m.iterations.v1.prdIds=['p2'];m.iterations.v1.currentPrdId='p2';m.demands.d1.prdId='p2';},
  m=>{m.prds.p1.contentDigest='sha256:'+'0'.repeat(64);m.prds.p1.evidence.remoteDigest=m.prds.p1.contentDigest;},
  m=>{m.prds.p1.path='other.md';},
  m=>{m.prds.p1.lifecycle='草稿';m.prds.p1.effective=false;},
 ]){
  const bad=structuredClone(mapping);change(bad);
  assert.equal(migrateLegacy(legacy,project,bad).ok,false);
  const next=structuredClone(good.state);next.prds=bad.prds;next.iterations=bad.iterations;next.projectDemands[0].prdId=bad.demands.d1.prdId;
  const result=await commitState({root:f.root,nextState:next,operationId:'migration',expected:{revision:0,stateDigest:before.stateDigest,projectDigest:before.projectDigest}});
  assert.equal(result.ok,false);assert.equal(result.committed,false);
  assert.equal(await readFile(statePath,'utf8'),encode(legacy));assert.equal(await readFile(projectPath,'utf8'),encode(project));await assertClean(f.root);
 }
 const historical=structuredClone(legacy);historical.projectDemands[0].prdId='historical';
 assert.equal(migrateLegacy(historical,project,mapping).ok,false);
 const noIdentity=structuredClone(legacy);delete noIdentity.prd.id;
 const noIdentityProject={...project,prd:noIdentity.prd};
 assert.equal(migrateLegacy(noIdentity,noIdentityProject,mapping).ok,true);
 const incomplete=structuredClone(mapping);incomplete.prds={};incomplete.iterations.v1.prdIds=[];incomplete.iterations.v1.currentPrdId=null;incomplete.demands.d1.prdId=null;
 assert.equal(migrateLegacy(noIdentity,noIdentityProject,incomplete).ok,false);
 const request={root:f.root,nextState:good.state,operationId:'migration',expected:{revision:0,stateDigest:before.stateDigest,projectDigest:before.projectDigest}};
 assert.equal((await commitState(request)).ok,true);assert.equal((await commitState(request)).code,'RESUMED');await assertClean(f.root);
});
