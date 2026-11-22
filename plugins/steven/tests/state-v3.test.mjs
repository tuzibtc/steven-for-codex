import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,rm,symlink,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest,encode,parse,projectProjection,validateState,loadProject,boundedPath } from '../scripts/lib/state.mjs';

import { sample } from './fixtures.mjs';
const check=(state,options={action:'develop',iterationId:'v1'})=>validateState(state,projectProjection(state),options);
const code=(r,c)=>r.issues.some(i=>i.code===c);

test('空项目可以读取研讨但不能开发，不以空集合全绿',()=>{
 const s={...sample(),currentIterationId:null,sourceDemands:[],projectDemands:[],prds:{},iterations:{}};
 assert.equal(check(s,{action:'read'}).valid,true);
 assert.equal(check(s).allowed,false);
 const s2=sample();s2.iterations.v1.scope.demandIds=[];s2.projectDemands=[];
 assert(code(check(s2),'SCOPE_UNAPPROVED'));
});
test('正确生效依据与批准集合允许正式研发，缺少远端回读不能冒充生效',()=>{
 assert.equal(check(sample()).allowed,true);
 for(const k of ['remoteCommit','remoteDigest','projectionsVerified','readBackAt']){const s=sample();delete s.prds.p1.evidence[k];assert(code(check(s),'EFFECTIVE_EVIDENCE'),k);}
 const s=sample();s.prds.p1.effective=false;assert.equal(check(s,{action:'discuss'}).allowed,true);assert(code(check(s),'PRD_NOT_EFFECTIVE'));
});
test('批准集合少项、多项、错迭代、错 PRD 分别拒绝',()=>{
 const absent=sample();absent.projectDemands=[];assert(code(check(absent),'SCOPE_MISSING'));
 const extra=sample();extra.projectDemands.push({...extra.projectDemands[0],projectDemandId:'d2'});assert(code(check(extra),'SCOPE_MISMATCH'));
 const wrong=sample();wrong.projectDemands[0].iterationId='other';assert.equal(check(wrong).allowed,false);
 const stale=sample();stale.projectDemands[0].prdId=null;assert(code(check(stale),'ACTIVE_PRD_MISMATCH'));
});
test('PRD 记录与迭代必须双向归属，同一路径不得冒充两份依据',()=>{
 const orphan=sample();orphan.prds.orphan={...orphan.prds.p1,path:'orphan.md'};
 assert.equal(check(orphan).allowed,false);assert(code(check(orphan),'PRD_OWNERSHIP'));
 for(const alias of ['PRD.md','./PRD.md','nested/../PRD.md']){
  const s=sample();s.prds.p2={...s.prds.p1,path:alias};s.iterations.v1.prdIds.push('p2');
  assert.equal(check(s).allowed,false,alias);assert(code(check(s),'PRD_PATH_DUPLICATE'));
 }
 const distinct=sample();distinct.prds.p2={...distinct.prds.p1,path:'PRD-v2.md'};distinct.iterations.v1.prdIds.push('p2');
 assert.equal(check(distinct).allowed,true);
});
test('合并和拆分比较有效末端，旧承接不算漏项，环和跨线拒绝',()=>{
 const s=sample();s.projectDemands[0].supersededBy=['d2','d3'];
 s.projectDemands.push(...['d2','d3'].map(id=>({...s.projectDemands[0],projectDemandId:id,supersededBy:[]})));
 assert.equal(check(s).allowed,true);
 s.projectDemands[1].supersededBy=['d1'];assert(code(check(s),'RELATION_CYCLE'));
 const x=sample();x.projectDemands[0].supersededBy=['missing'];assert(code(check(x),'RELATION_CROSS_ITERATION'));
});
test('多未来母稿可研讨，未完成基线不可开发；已完成未部署可继续',()=>{
 const s=sample();s.iterations.v2={...structuredClone(s.iterations.v1),baselineIterationId:'v1',prdIds:[],currentPrdId:null,draftPrdId:null,development:{status:'not-started'}};
 s.iterations.v3={...structuredClone(s.iterations.v2)};
 assert.equal(check(s,{action:'discuss',iterationId:'v2'}).allowed,true);
 assert(code(check(s,{action:'develop',iterationId:'v2'}),'BASELINE_INCOMPLETE'));
 s.iterations.v1.development.status='completed';s.iterations.v1.completion={version:'1.0',userApprovalReference:'user:accept',evidence:'evidence:full'};
 s.prds.p2={...s.prds.p1,path:'PRD-v2.md',iterationId:'v2'};s.iterations.v2.prdIds=['p2'];s.iterations.v2.currentPrdId='p2';
 s.iterations.v2.scope={approvalReference:'user:scope2',demandIds:['d2']};s.iterations.v2.development={status:'active',approvalReference:'user:dev2',technicalPlanApprovalReference:'user:plan2'};
 s.projectDemands.push({...s.projectDemands[0],projectDemandId:'d2',iterationId:'v2',prdId:'p2'});
 assert.equal(check(s,{action:'develop',iterationId:'v2'}).allowed,true);
});
test('双研发线及基线循环拒绝；部署不是放行条件',()=>{
 const s=sample();s.iterations.v2={...structuredClone(s.iterations.v1),prdIds:[],currentPrdId:null};
 assert(code(check(s),'DEVELOPMENT_CONCURRENT'));
 s.iterations.v1.baselineIterationId='v2';s.iterations.v2.baselineIterationId='v1';assert(code(check(s),'BASELINE_CYCLE'));
});
test('旧版维护不被未来母稿/研发线误拦，但须对应版本与修复范围',()=>{
 const s=sample();s.iterations.v1.development.status='completed';s.iterations.v1.completion={version:'1.0',userApprovalReference:'user:accept',evidence:'real'};
 s.iterations.v1.maintenance={prdId:'p1',approvalReference:'user:fix',changesProductFacts:false,scopeDemandIds:['d1']};
 s.iterations.future={...structuredClone(s.iterations.v1),baselineIterationId:'v1',prdIds:[],currentPrdId:null,maintenance:undefined,development:{status:'active'}};
 assert.equal(check(s,{action:'maintain',iterationId:'v1',version:'1.0'}).allowed,true);
 assert(code(check(s,{action:'maintain',iterationId:'v1',version:'2.0'}),'MAINTENANCE_VERSION'));
 s.iterations.v1.maintenance.changesProductFacts=true;assert(code(check(s,{action:'maintain',iterationId:'v1',version:'1.0'}),'MAINTENANCE_AUTHORITY'));
});
test('部分同步/未知结果只拦相关执行，投影不能反盖底稿',()=>{
 const s=sample();s.lastOperation.status='unknown';
 assert.equal(check(s,{action:'read'}).allowed,true);assert(code(check(s),'OPERATION_PENDING'));
 s.iterations.unrelated={baselineIterationId:null,prdIds:[],currentPrdId:null,draftPrdId:null,development:{status:'not-started'}};
 s.lastOperation.affectedIterationIds=['unrelated'];assert.equal(check(s).allowed,true);
 s.lastOperation={operationId:'new',status:'completed',unresolved:{old:{operationId:'old',status:'unknown',affectedIterationIds:['unrelated']}}};
 assert.equal(check(s).allowed,true);
 s.lastOperation.unresolved.old.affectedIterationIds=['v1'];assert(code(check(s),'OPERATION_PENDING'));
 const p=projectProjection(s);p.revision=9;const r=validateState(s,p,{action:'develop',iterationId:'v1'});
 assert.equal(r.valid,true);assert.equal(r.allowed,false);assert(code(r,'PROJECTION_MISMATCH'));assert.equal(s.revision,0);
});
test('正式完成与需求已实现必须有用户验收和真实结果',()=>{
 const s=sample();s.iterations.v1.development.status='completed';assert(code(check(s),'COMPLETION_EVIDENCE'));
 s.projectDemands[0].business={status:'已实现',currentFlow:null};assert(code(check(s),'ACCEPTANCE_MISSING'));
 assert(code(check(sample(),{action:'accept',iterationId:'v1'}),'ACCEPTANCE_PENDING'));
});
test('任意 JSON 类型和坏数组不崩溃，不用异常消息决定放行',()=>{
 for(const v of [null,[],1,'x',true,{}, {schemaVersion:'99'}]){assert.doesNotThrow(()=>validateState(v,v));assert.equal(validateState(v,v).allowed,false);}
 for(const key of ['sourceDemands','projectDemands','iterations','prds'])for(const v of [null,1,'x',[],{},true]){const s=sample();s[key]=v;assert.doesNotThrow(()=>validateState(s,{}));}
 const s=sample();s.iterations.v1.prdIds={includes:'not-a-function'};assert.doesNotThrow(()=>check(s));assert.equal(check(s).valid,false);
 assert.equal(parse('null').value,null);assert.equal(parse('{broken').issues[0].code,'INVALID_JSON');
});
test('未知扩展保留提示，派生不修改源对象与入口额外导航',()=>{
 const s=sample();s.custom={keep:'yes'};const before=encode(s);const p=projectProjection(s,{manualLink:'keep'});
 assert.equal(p.manualLink,'keep');assert.equal(encode(s),before);assert(code(check(s),'EXTENSION'));
});
test('安装与技术批准导航从底稿派生，旧投影不能静默继续使用',()=>{
 const s=sample();s.software={installedVersion:'0.1.1',installedPrdVersion:'v0.3'};
 s.technicalPlan={status:'approved',approvalReference:'user:plan'};
 const stale=projectProjection(s);stale.software={installedVersion:'0.1.0'};stale.technicalPlan={status:'pending'};
 assert(code(validateState(s,stale,{action:'develop',iterationId:'v1'}),'PROJECTION_MISMATCH'));
 const repaired=projectProjection(s,{...stale,manualLink:'keep'});
 assert.deepEqual(repaired.software,s.software);assert.deepEqual(repaired.technicalPlan,s.technicalPlan);
 assert.equal(repaired.manualLink,'keep');assert.equal(validateState(s,repaired,{action:'develop',iterationId:'v1'}).allowed,true);
 repaired.software.installedVersion='changed';assert.equal(s.software.installedVersion,'0.1.1');
});
test('恶意或畸形叶字段不触发隐式对象转字符串异常',()=>{
 const paths=['sourceDemands.0.initialPriority.p','projectDemands.0.priority.d','projectDemands.0.business.status','prds.p1.contentDigest','iterations.v1.currentPrdId','iterations.v1.baselineIterationId','currentIterationId','iterations.v1.scope.demandIds'];
 for(const p of paths)for(const v of [{toString:null},[{toString:null}],null,true,1]){
  const s=sample(),parts=p.split('.');let parent=s;for(const k of parts.slice(0,-1))parent=parent[k];parent[parts.at(-1)]=v;
  assert.doesNotThrow(()=>check(s),p);if(!(p==='currentIterationId'&&v===null)&&!(p==='iterations.v1.baselineIterationId'&&v===null)&&!(p==='iterations.v1.currentPrdId'&&v===null))assert.equal(check(s).allowed,false,p);
 }
 assert.doesNotThrow(()=>check(sample(),{action:'develop',iterationId:{toString:null}}));
});
test('畸形操作记录不被忽略，未完成空影响集合不绕过阻断',()=>{
 for(const v of [true,1,'unknown',[],[null],{}, {operationId:'x',status:'typo'}]){const s=sample();s.lastOperation=v;assert(code(check(s),'OPERATION_TYPE'));assert.equal(check(s).allowed,false);}
 const empty=sample();empty.lastOperation=null;assert.equal(check(empty).valid,true);
 const s=sample();s.lastOperation.status='unknown';s.lastOperation.affectedIterationIds=[];assert(code(check(s),'OPERATION_PENDING'));
 s.lastOperation.affectedIterationIds=[null];assert(code(check(s),'OPERATION_SCOPE'));
 s.lastOperation.affectedIterationIds=['typo-version'];assert(code(check(s),'OPERATION_SCOPE'));assert.equal(check(s).allowed,false);
 for(const value of [true,[],{x:{operationId:'x',status:'completed'}},{x:{operationId:'y',status:'unknown'}},{x:{operationId:'x',status:'unknown',unresolved:{}}}]){
  const bad=sample();bad.lastOperation.unresolved=value;assert.equal(check(bad).allowed,false);
 }
});
test('进行中版本不能通过伪装旧版维护绕过研发检查',()=>{
 const s=sample();s.iterations.v1.completion={version:'1.0'};s.iterations.v1.maintenance={prdId:'p1',approvalReference:'user:fix',changesProductFacts:false,scopeDemandIds:['d1']};
 assert(code(check(s,{action:'maintain',iterationId:'v1',version:'1.0'}),'MAINTENANCE_BASELINE'));
});
test('本地摘要及 symlink/上层逃逸拒绝，读取失败结构化',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'steven-v3-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'.steven/state'),{recursive:true});await writeFile(path.join(root,'PRD.md'),'基线');
 const s=sample();await writeFile(path.join(root,'.steven/state/authorized.json'),encode(s));await writeFile(path.join(root,'.steven/project.json'),encode(projectProjection(s)));
 assert.equal((await loadProject(root,{action:'develop',iterationId:'v1'})).allowed,true);
 await symlink(root,path.join(root,'alias'));
 const aliased=structuredClone(s);aliased.prds.p2={...s.prds.p1,path:'alias/PRD.md'};aliased.iterations.v1.prdIds.push('p2');
 await writeFile(path.join(root,'.steven/state/authorized.json'),encode(aliased));
 assert(code(await loadProject(root),'PRD_PATH_DUPLICATE'));
 await writeFile(path.join(root,'.steven/state/authorized.json'),encode(s));
 await writeFile(path.join(root,'PRD.md'),'改变');assert(code(await loadProject(root),'PRD_DIGEST_MISMATCH'));
 await symlink('/etc/hosts',path.join(root,'outside'));await assert.rejects(()=>boundedPath(root,'outside'),{code:'PATH_BOUNDARY'});
 await assert.rejects(()=>boundedPath(root,'../outside'),{code:'PATH_BOUNDARY'});
 await symlink('/tmp',path.join(root,'escape'));await assert.rejects(()=>boundedPath(root,'escape/new',{missing:true}),{code:'PATH_BOUNDARY'});
 await writeFile(path.join(root,'.steven/state/authorized.json'),'null');assert.equal((await loadProject(root)).valid,false);
 assert.equal(await readFile(path.join(root,'PRD.md'),'utf8'),'改变');
});
test('磁盘 PRD 路径为畸形 JSON 时仍返回诊断，不在错误报告中崩溃',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'steven-v3-path-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(path.join(root,'.steven/state'),{recursive:true});
 for(const value of [{toString:null},[{toString:null}],{},true,1,null]){
  const s=sample();s.prds.p1.path=value;
  await writeFile(path.join(root,'.steven/state/authorized.json'),encode(s));await writeFile(path.join(root,'.steven/project.json'),encode(projectProjection(s)));
  const result=await loadProject(root,{action:'develop',iterationId:'v1'});
  assert.equal(result.allowed,false);assert(code(result,'PRD_RECORD'));assert(code(result,'PATH_BOUNDARY'));
 }
});
