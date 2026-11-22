import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const created = [];
async function trackedTemp(prefix) { const root = await mkdtemp(prefix); created.push(root); return root; }
test.after(async () => { for (const root of created) await rm(root, { recursive: true, force: true }); });

const validator = path.resolve(import.meta.dirname, "../scripts/validate-recovery-package.mjs");

async function runWith(value, extra = []) {
  const root = await trackedTemp(path.join(tmpdir(), "steven-recovery-package-"));
  const file = path.join(root, "slice.json");
  await writeFile(file, JSON.stringify(value));
  return spawnSync(process.execPath, [validator, file, ...extra], { encoding: "utf8" });
}

const valid = {
  schemaVersion: "1",
  kind: "steven-github-readonly-recovery-slice",
  capturedAt: "2026-08-26T00:00:00+08:00",
  readOnly: true,
  source: { owner: "example", repository: "demo", projectNumber: 1, projectId: "PVT_demo" },
  fieldCatalog: [{ name: "状态", id: "field_status" }],
  demands: [{ kind: "source", issueId: "I_demo", number: 1, url: "https://example.invalid/1", title: "示例", githubState: "OPEN", fields: { 状态: "待处理" } }],
};

test("最小只读补充包通过结构和凭据检查", async () => {
  const run = await runWith(valid);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

test("补充包拒绝疑似凭据", async () => {
  const run = await runWith({ ...valid, accidental: "github_pat_" + "a".repeat(32) });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /疑似凭据/);
});

test('畸形恢复包返回结构化失败而非崩溃；旧包不能冒充全读', async()=>{
 for(const v of [null,[],true,{...valid,demands:{}},{...valid,demands:[null]}]){const r=await runWith(v);assert.equal(r.status,1);assert.equal(JSON.parse(r.stdout).valid,false);}
 const old=await runWith(valid,['--require-complete']);assert.equal(old.status,1);assert.equal(JSON.parse(old.stdout).complete,false);
});
test('正文与全部评论、字段分页均完备才可声明覆盖完整', async()=>{
 const v=structuredClone(valid);v.coverage={demandsComplete:true,fieldsComplete:true,hasNextPage:false};
 Object.assign(v.demands[0],{body:'原文',comments:[{id:'c1',body:'补充'}],coverage:{bodyComplete:true,commentsComplete:true,hasNextPage:false,totalComments:1}});
 const ok=await runWith(v,['--require-complete']);assert.equal(ok.status,0);assert.equal(JSON.parse(ok.stdout).complete,true);
 v.demands[0].coverage.totalComments=2;const incomplete=await runWith(v,['--require-complete']);assert.equal(incomplete.status,1);assert.equal(JSON.parse(incomplete.stdout).complete,false);
});
test('空集或结构无效的包不得同时声明完整覆盖',async()=>{
 const v=structuredClone(valid);v.coverage={demandsComplete:true,fieldsComplete:true,hasNextPage:false};v.demands=[];
 const empty=JSON.parse((await runWith(v,['--require-complete'])).stdout);assert.equal(empty.allowed,false);assert.equal(empty.complete,false);
 const full=structuredClone(valid);full.coverage=v.coverage;Object.assign(full.demands[0],{body:'原文',comments:[],coverage:{bodyComplete:true,commentsComplete:true,hasNextPage:false,totalComments:0}});full.source.projectId='';
 const invalid=JSON.parse((await runWith(full,['--require-complete'])).stdout);assert.equal(invalid.valid,false);assert.equal(invalid.complete,false);
});
test('完整包仍须拒绝互相矛盾的卡号、链接和字段身份',async()=>{
 const full=structuredClone(valid);full.coverage={demandsComplete:true,fieldsComplete:true,hasNextPage:false};
 Object.assign(full.demands[0],{body:'原文',comments:[],coverage:{bodyComplete:true,commentsComplete:true,hasNextPage:false,totalComments:0}});
 full.demands.push({...structuredClone(full.demands[0]),issueId:'I_second',number:2,url:'https://example.invalid/2'});
 assert.equal(JSON.parse((await runWith(full,['--require-complete'])).stdout).complete,true);
 for(const [label,mutate]of [
  ['same number, different issue',v=>{v.demands[1].number=1;}],
  ['same URL, different issue',v=>{v.demands[1].url=v.demands[0].url;}],
  ['duplicate field identity',v=>{v.fieldCatalog.push({...v.fieldCatalog[0],name:'另一字段'});} ],
  ['invalid field record',v=>{v.fieldCatalog=[null];} ],
 ]){
  const v=structuredClone(full);mutate(v);const r=await runWith(v,['--require-complete']);const out=JSON.parse(r.stdout);
  assert.equal(out.allowed,false,label);assert.equal(out.complete,false,label);assert.equal(r.status,1,label);
 }
});
test('恢复包元数据不能只有字段名却没有可解释的值',async()=>{
 const full=structuredClone(valid);full.coverage={demandsComplete:true,fieldsComplete:true,hasNextPage:false};
 Object.assign(full.demands[0],{body:'原文',comments:[],coverage:{bodyComplete:true,commentsComplete:true,hasNextPage:false,totalComments:0}});
 for(const [label,mutate]of [
  ['捕获时间错误类型',v=>{v.capturedAt=false;}],
  ['捕获时间不可解析',v=>{v.capturedAt='unknown';}],
  ['来源类别错误类型',v=>{v.demands[0].kind={};}],
  ['标题错误类型',v=>{v.demands[0].title=42;}],
  ['平台状态错误类型',v=>{v.demands[0].githubState=[];}],
  ['空平台状态',v=>{v.demands[0].githubState=' ';}],
 ]){
  const v=structuredClone(full);mutate(v);const r=await runWith(v,['--require-complete']);const out=JSON.parse(r.stdout);
  assert.equal(out.allowed,false,label);assert.equal(out.complete,false,label);assert.equal(r.status,1,label);
 }
 const extensible=structuredClone(full);extensible.demands[0].kind='future-kind';extensible.extra={description:'保留扩展供Agent核对'};
 const out=JSON.parse((await runWith(extensible,['--require-complete'])).stdout);
 assert.equal(out.valid,true);assert.equal(out.warnings.length>0,true);
});
