import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { sample } from './fixtures.mjs';
import { encode,projectProjection } from '../scripts/lib/state.mjs';

const created = [];
async function trackedTemp(prefix) { const root = await mkdtemp(prefix); created.push(root); return root; }
test.after(async () => { for (const root of created) await rm(root, { recursive: true, force: true }); });

const pluginRoot = path.resolve(import.meta.dirname, "..");
const inspector = path.join(pluginRoot, "scripts", "inspect-project.mjs");

function git(root, args) {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

async function fixture() {
  const root = await trackedTemp(path.join(tmpdir(), "steven-inspect-test-"));
  await mkdir(path.join(root, ".steven", "state"), { recursive: true });
  await mkdir(path.join(root, "产品文档"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "# 规则\n");
  await writeFile(path.join(root, "产品文档", "测试_PRD_v0.1_定稿.md"), "# 测试 PRD\n");
  const current = "产品文档/测试_PRD_v0.1_定稿.md";
  await writeFile(path.join(root, ".steven", "project.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_test", prd: { current, lifecycle: "定稿" } }));
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_test", sourceDemands: [], projectDemands: [], prd: { current, lifecycle: "定稿" } }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "steven-test@example.invalid"]);
  git(root, ["config", "user.name", "Steven Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return root;
}

test("识别唯一生效 PRD 和干净 Git 基线", async () => {
  const root = await fixture();
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.steven.projectId, "project_test");
  assert.equal(result.prd.configuredExists, true);
  assert.equal(result.prd.configuredGitStatus, null);
  assert.equal(result.prd.configuredTracked, true);
  assert.match(result.prd.configuredCommit, /^[0-9a-f]{40}$/);
  assert.equal(result.prd.fileVersion, "0.1");
  assert.deepEqual(result.warnings, []);
});

test('精简读取省略未跟踪路径但保留数量、已跟踪改动及全部阻断',async()=>{
 const root=await fixture();
 for(let i=0;i<40;i++)await writeFile(path.join(root,`untracked-${i}.txt`),'保留的用户材料');
 await appendFile(path.join(root,'AGENTS.md'),'\n局部工作约定\n');
 for(const dirtyPrd of [false,true]){
  if(dirtyPrd)await appendFile(path.join(root,'产品文档','测试_PRD_v0.1_定稿.md'),'未经批准的修改\n');
  const full=spawnSync(process.execPath,[inspector,root],{encoding:'utf8'});
  const short=spawnSync(process.execPath,[inspector,root,'--summary'],{encoding:'utf8'});
  const a=JSON.parse(full.stdout),b=JSON.parse(short.stdout);
  assert.equal(short.status,full.status);assert.equal(short.status,dirtyPrd?2:0);
  assert.deepEqual(b.issues,a.issues);assert.deepEqual(b.validation,a.validation);assert.deepEqual(b.prd,a.prd);
  assert.equal(a.git.worktreeStatus.filter(s=>s.startsWith('?? ')).length,40);
  assert.deepEqual(b.git.worktreeStatus,a.git.worktreeStatus.filter(s=>!s.startsWith('?? ')));
  assert.deepEqual(b.git.omittedUntracked,{entries:40,details:'省略未跟踪路径；不带 --summary 查看完整状态，目录条目不等于文件数'});
  assert(short.stdout.length<full.stdout.length);
  if(dirtyPrd)assert(b.validation.blocked.some(i=>i.code==='PRD_DIRTY'));
 }
});

test("发现两个状态文件的当前 PRD 指针错位", async () => {
  const root = await fixture();
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({
    schemaVersion: "2", projectId: "project_test", sourceDemands: [], projectDemands: [], prd: { current: "产品文档/另一个_PRD_v0.2_定稿.md", lifecycle: "定稿" },
  }));
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /两个状态文件的当前 PRD 指针不一致/);
});

test('畸形导航只输出结构化阻断，不在版本或迭代显示时崩溃',async()=>{
 const root=await fixture();
 const projectPath=path.join(root,'.steven/project.json'),statePath=path.join(root,'.steven/state/authorized.json');
 const project=JSON.parse(await readFile(projectPath,'utf8')),state=JSON.parse(await readFile(statePath,'utf8'));
 state.prd.current={toString:null};project.prd.current={toString:null};
 await writeFile(statePath,encode(state));await writeFile(projectPath,encode(project));
 let run=spawnSync(process.execPath,[inspector,root],{encoding:'utf8'});
 assert.equal(run.status,2,run.stderr);assert.equal(JSON.parse(run.stdout).validation.allowed,false);
 const v3=sample();v3.currentIterationId={toString:null};await writeFile(statePath,encode(v3));await writeFile(projectPath,encode(projectProjection(v3)));
 run=spawnSync(process.execPath,[inspector,root],{encoding:'utf8'});
 assert.equal(run.status,2,run.stderr);assert.equal(JSON.parse(run.stdout).validation.allowed,false);
});

test("新项目尚无 PRD 时不伪报警告", async () => {
  const root = await fixture();
  const projectFile = path.join(root, ".steven", "project.json");
  const stateFile = path.join(root, ".steven", "state", "authorized.json");
  const project = JSON.parse(await readFile(projectFile, "utf8"));
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  project.prd = { current: null, draft: null, lifecycle: "不存在", contentDigest: null };
  state.prd = { current: null, draft: null, lifecycle: "不存在", contentDigest: null };
  await writeFile(projectFile, JSON.stringify(project));
  await writeFile(stateFile, JSON.stringify(state));
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.doesNotMatch(run.stdout, /无法唯一确定当前生效 PRD/);
});

test("发现 PRD 文件名与正文版本不一致", async () => {
  const root = await fixture();
  await writeFile(path.join(root, "产品文档", "测试_PRD_v0.1_定稿.md"), "# 测试 PRD v0.2\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "introduce mismatch"]);
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /文件名与正文版本不一致/);
});

test("发现定稿 PRD 出现未提交改动并阻止静默继续", async () => {
  const root = await fixture();
  await appendFile(path.join(root, "产品文档", "测试_PRD_v0.1_定稿.md"), "未经授权的变化\n");
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /当前生效 PRD 存在未提交改动/);
  assert.equal(JSON.parse(run.stdout).validation.allowed,false);
  assert(JSON.parse(run.stdout).validation.blocked.some(i=>i.code==='PRD_DIRTY'));
});

test('旧版维护检查对应依据，不被不相关未来母稿缺页或新导航替换',async()=>{
 const root=await fixture(),s=sample();await writeFile(path.join(root,'PRD.md'),'基线');
 s.iterations.v1.development.status='completed';s.iterations.v1.completion={version:'1.0',userApprovalReference:'user:accept',evidence:'verified'};
 s.iterations.v1.maintenance={prdId:'p1',approvalReference:'user:repair',changesProductFacts:false,scopeDemandIds:['d1']};
 s.iterations.future={baselineIterationId:'v1',prdIds:['future'],currentPrdId:null,draftPrdId:'future',scope:null,development:{status:'not-started'}};
 s.prds.future={iterationId:'future',path:'missing-future.md',lifecycle:'草稿',effective:false};s.currentIterationId='future';
 await writeFile(path.join(root,'.steven/state/authorized.json'),encode(s));await writeFile(path.join(root,'.steven/project.json'),encode(projectProjection(s)));
 git(root,['add','.']);git(root,['commit','-qm','scoped maintenance']);
 const scoped=spawnSync(process.execPath,[inspector,root,'--action=maintain','--iteration=v1','--version=1.0'],{encoding:'utf8'});
 const result=JSON.parse(scoped.stdout);assert.equal(scoped.status,0,scoped.stdout);assert.equal(result.prd.configured,'PRD.md');assert.equal(result.prd.effective,true);assert.equal(result.validation.allowed,true);
 const global=spawnSync(process.execPath,[inspector,root],{encoding:'utf8'});assert.equal(global.status,2);assert.match(global.stdout,/missing-future/);
 const wrong=spawnSync(process.execPath,[inspector,root,'--iteration=missing'],{encoding:'utf8'});assert.equal(wrong.status,2);
});

test("发现另一个上下文已经改变 Git 基线", async () => {
  const root = await fixture();
  const oldHead = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  await writeFile(path.join(root, "新事实.md"), "来自另一个上下文\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "other context"]);
  const run = spawnSync(process.execPath, [inspector, root, `--expected-head=${oldHead}`], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /项目基线已被其他上下文改变/);
});

test("发现状态文件记录的 PRD 摘要与正文不一致", async () => {
  const root = await fixture();
  const projectPath = path.join(root, ".steven", "project.json");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  project.prd.contentDigest = "sha256:deadbeef";
  await writeFile(projectPath, JSON.stringify(project));
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "introduce digest mismatch"]);
  const run = spawnSync(process.execPath, [inspector, root], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stdout, /PRD 摘要与正文不一致/);
});

test('仓库内子项目及其工作子目录读取最近入口，不误读父项目',async()=>{
 const root=await fixture(),nested=path.join(root,'nested');
 await mkdir(path.join(nested,'.steven/state'),{recursive:true});await mkdir(path.join(nested,'src'),{recursive:true});
 const s=sample();s.projectId='nested-project';
 await writeFile(path.join(nested,'PRD.md'),'基线');await writeFile(path.join(nested,'AGENTS.md'),'# 子项目\n');
 await writeFile(path.join(nested,'.steven/state/authorized.json'),encode(s));await writeFile(path.join(nested,'.steven/project.json'),encode(projectProjection(s)));
 git(root,['add','.']);git(root,['commit','-qm','nested fixture']);
 for(const requested of [nested,path.join(nested,'src')]){
  const run=spawnSync(process.execPath,[inspector,requested],{encoding:'utf8'});
  assert.equal(run.status,0,run.stdout+run.stderr);const result=JSON.parse(run.stdout);
  assert.equal(result.projectRoot,nested);assert.equal(result.steven.projectId,'nested-project');assert.equal(result.prd.configuredTracked,true);
 }
 await writeFile(path.join(nested,'.steven/project.json'),'{broken');
 const broken=spawnSync(process.execPath,[inspector,nested],{encoding:'utf8'});
 assert.equal(broken.status,2);assert.equal(JSON.parse(broken.stdout).projectRoot,nested);
 await rm(path.join(nested,'.steven/project.json'));
 const partial=spawnSync(process.execPath,[inspector,nested],{encoding:'utf8'});
 assert.equal(partial.status,2);assert.equal(JSON.parse(partial.stdout).projectRoot,nested);
});
