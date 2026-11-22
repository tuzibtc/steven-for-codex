import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,symlink} from 'node:fs/promises';import {execFileSync} from 'node:child_process';import path from 'node:path';import {tmpdir} from 'node:os';
import {sample} from './fixtures.mjs';import {digest,encode,loadProject,projectProjection} from '../scripts/lib/state.mjs';import {commitState} from '../scripts/lib/controlled-write.mjs';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'steven-history-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'.steven/state'),{recursive:true});
 const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','-q');await writeFile(path.join(root,'old.md'),'基线');git('add','old.md');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','historical fixture');
 const s=sample();s.prds.p1.path='old.md';s.prds.p1.evidence.remoteCommit=git('rev-parse','HEAD');s.prds.p2={...structuredClone(s.prds.p1),path:'current.md',contentDigest:digest('后继'),evidence:{...s.prds.p1.evidence,remoteDigest:digest('后继')}};s.iterations.v1.prdIds.push('p2');s.iterations.v1.currentPrdId='p2';s.projectDemands[0].prdId='p2';await writeFile(path.join(root,'current.md'),'后继');
 const save=async()=>{await writeFile(path.join(root,'.steven/state/authorized.json'),encode(s));await writeFile(path.join(root,'.steven/project.json'),encode(projectProjection(s)));};await save();return {root,s,save,git};
}
test('无当前用途的历史定稿退出工作区后，从同仓库Git核对原文且受控写入继续',async t=>{
 const f=await fixture(t);await rm(path.join(f.root,'old.md'));const loaded=await loadProject(f.root);assert.equal(loaded.valid,true,JSON.stringify(loaded.issues));assert.equal(loaded.files.find(p=>p.id==='p1').storage,'git-history');
 const next=structuredClone(f.s);next.revision=1;next.lastOperation={operationId:'after-history-cleanup',status:'completed'};
 const r=await commitState({root:f.root,expected:{stateDigest:loaded.stateDigest,projectDigest:loaded.projectDigest,revision:0},nextState:next,operationId:next.lastOperation.operationId});assert.equal(r.ok,true,JSON.stringify(r));await assert.rejects(readFile(path.join(f.root,'old.md')));assert.equal((await loadProject(f.root)).state.revision,1);
});
test('当前依据和维护依据缺失不能借Git历史放行',async t=>{
 for(const kind of ['current','maintenance']){const f=await fixture(t);if(kind==='current'){f.s.iterations.v1.currentPrdId='p1';f.s.projectDemands[0].prdId='p1';}else f.s.iterations.v1.maintenance={prdId:'p1'};await f.save();await rm(path.join(f.root,'old.md'));assert.equal((await loadProject(f.root)).valid,false,kind);}
});
test('历史缺证、摘要错误、路径越界和符号链接均不从历史掩盖',async t=>{
 for(const kind of ['missing-commit','wrong-digest','escape','symlink','dangling-symlink','tampered-present']){const f=await fixture(t);if(kind==='missing-commit')f.s.prds.p1.evidence.remoteCommit='f'.repeat(40);if(kind==='wrong-digest'){f.s.prds.p1.contentDigest=digest('错误');f.s.prds.p1.evidence.remoteDigest=digest('错误');}if(kind==='escape')f.s.prds.p1.path='../old.md';await f.save();await rm(path.join(f.root,'old.md'));if(kind==='symlink'||kind==='dangling-symlink')await symlink(path.join(f.root,kind==='symlink'?'current.md':'missing.md'),path.join(f.root,'old.md'));if(kind==='tampered-present')await writeFile(path.join(f.root,'old.md'),'被改了');assert.equal((await loadProject(f.root)).valid,false,kind);}
});
test('历史父目录可退出，但不接受越界父链接或Git里的符号链接原件',async t=>{
 for(const kind of ['retired-directory','escaped-parent','historical-symlink']){const f=await fixture(t);await mkdir(path.join(f.root,'history'));await writeFile(path.join(f.root,'history/old.md'),'基线');
  if(kind==='historical-symlink'){await rm(path.join(f.root,'history/old.md'));await symlink('../current.md',path.join(f.root,'history/old.md'));f.s.prds.p1.contentDigest=digest('../current.md');f.s.prds.p1.evidence.remoteDigest=digest('../current.md');}
  f.git('add','history');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','historical directory');f.s.prds.p1.path='history/old.md';f.s.prds.p1.evidence.remoteCommit=f.git('rev-parse','HEAD');await f.save();await rm(path.join(f.root,'history'),{recursive:true});if(kind==='escaped-parent')await symlink(path.dirname(f.root),path.join(f.root,'history'));assert.equal((await loadProject(f.root)).valid,kind==='retired-directory',kind);
 }
});
test('已被替代且不再维护的完成版本可查历史；定位该版本实施时仍要求工作依据',async t=>{
 const f=await fixture(t);f.s.iterations.v0={baselineIterationId:null,prdIds:['p1'],currentPrdId:'p1',draftPrdId:null,development:{status:'completed'},completion:{version:'0.0',evidence:'fixture:tested',userApprovalReference:'fixture:approved'}};f.s.prds.p1.iterationId='v0';f.s.iterations.v1.prdIds=['p2'];f.s.iterations.v1.baselineIterationId='v0';await f.save();await rm(path.join(f.root,'old.md'));assert.equal((await loadProject(f.root)).valid,true);assert.equal((await loadProject(f.root,{iterationId:'v0'})).valid,false);assert.equal((await loadProject(f.root,{iterationId:'v1',action:'develop'})).allowed,true);
});
test('全新克隆和仓库内子项目可读取退出的历史原文，不把路径当通配符',async t=>{
 const f=await fixture(t);const nested=path.join(f.root,'nested project');await mkdir(path.join(nested,'.steven/state'),{recursive:true});
 await writeFile(path.join(nested,'old[1].md'),'基线');await writeFile(path.join(nested,'current.md'),'后继');f.git('add','nested project');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','nested baseline');
 f.s.prds.p1.path='old[1].md';f.s.prds.p1.evidence.remoteCommit=f.git('rev-parse','HEAD');await writeFile(path.join(nested,'.steven/state/authorized.json'),encode(f.s));await writeFile(path.join(nested,'.steven/project.json'),encode(projectProjection(f.s)));await rm(path.join(nested,'old[1].md'));f.git('add','-A','nested project');f.git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','retire nested history');
 const clone=await mkdtemp(path.join(tmpdir(),'steven-history-clone-'));t.after(()=>rm(clone,{recursive:true,force:true}));execFileSync('git',['clone','--quiet','--no-hardlinks',f.root,clone]);
 const target=path.join(clone,'nested project'),loaded=await loadProject(target);assert.equal(loaded.valid,true,JSON.stringify(loaded.issues));assert.equal(loaded.files.find(p=>p.id==='p1').storage,'git-history');
 const next=structuredClone(f.s);next.revision=1;next.lastOperation={operationId:'fresh-clone',status:'completed'};const r=await commitState({root:target,expected:{stateDigest:loaded.stateDigest,projectDigest:loaded.projectDigest,revision:0},nextState:next,operationId:'fresh-clone'});assert.equal(r.ok,true,JSON.stringify(r));await assert.rejects(readFile(path.join(target,'old[1].md')));
});
