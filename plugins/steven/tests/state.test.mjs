import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const created = [];
async function trackedTemp(prefix) { const root = await mkdtemp(prefix); created.push(root); return root; }
test.after(async () => { for (const root of created) await rm(root, { recursive: true, force: true }); });

const pluginRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(pluginRoot, "scripts", "validate-state.mjs");

async function fixture({ mismatch = false, secret = false, withoutPrd = false } = {}) {
  const root = await trackedTemp(path.join(tmpdir(), "steven-state-test-"));
  await mkdir(path.join(root, ".steven", "state"), { recursive: true });
  const current = withoutPrd ? null : "产品文档/测试_PRD_v0.1_定稿.md";
  if (!withoutPrd) {
    await mkdir(path.join(root, "产品文档"), { recursive: true });
    await writeFile(path.join(root, current), "# 测试 PRD\n");
  }
  await writeFile(path.join(root, ".steven", "project.json"), JSON.stringify({
    schemaVersion: "2",
    projectId: "project_test",
    prd: withoutPrd
      ? { current: null, draft: null, version: null, lifecycle: "不存在", contentDigest: null }
      : { current, draft: null, version: "v0.1", lifecycle: "定稿" },
    note: secret ? "api_key=abcdefgh12345678" : undefined,
  }));
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({
    schemaVersion: "2",
    projectId: mismatch ? "project_wrong" : "project_test",
    sourceDemands: [],
    projectDemands: [],
    prd: withoutPrd
      ? { current: null, draft: null, version: null, lifecycle: "不存在", contentDigest: null }
      : { current, draft: null, version: "v0.1", lifecycle: "定稿" },
  }));
  return root;
}

async function fixtureWithDemand({ status = "开发中", flow = "产品验收", approval = null, p = "P1" } = {}) {
  const root = await fixture();
  const file = path.join(root, ".steven", "state", "authorized.json");
  const state = JSON.parse(await readFile(file, "utf8"));
  state.sourceDemands = [{
    sourceDemandId: "source_1",
    initialPriority: { p: "P1", d: "D0" },
    github: { repositoryId: "R_1", projectId: "PVT_1", issueId: "I_1", projectItemId: "PVTI_1", url: "https://example.invalid/issues/1" },
  }];
  state.projectDemands = [{
    projectDemandId: "project_demand_1",
    sourceDemandId: "source_1",
    priority: { p, d: "D0" },
    business: { status, currentFlow: flow },
    prdId: "prd_1",
    acceptance: { userApprovalReference: approval },
  }];
  await writeFile(file, JSON.stringify(state));
  return root;
}

test("最小项目状态有效", async () => {
  const root = await fixture();
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

test("新项目可以先有状态底稿而没有空白 PRD", async () => {
  const root = await fixture({ withoutPrd: true });
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).valid, true);
});

test("拒绝项目身份冲突", async () => {
  const root = await fixture({ mismatch: true });
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /projectId 不一致/);
});

test("拒绝状态文件中的疑似秘密", async () => {
  const root = await fixture({ secret: true });
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /疑似包含秘密/);
});

test("需求源和项目承接的 P/D、状态与流程合法时通过", async () => {
  const root = await fixtureWithDemand();
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

test("拒绝非法 P/D 与业务状态流程串线", async () => {
  const root = await fixtureWithDemand({ status: "待处理", flow: "产品验收", p: "P9" });
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /P\/D 必须/);
  assert.match(run.stdout, /业务状态与当前流程不匹配/);
});

test("已实现必须保留用户验收批准依据", async () => {
  const root = await fixtureWithDemand({ status: "已实现", flow: null });
  const run = spawnSync(process.execPath, [validator, root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /没有用户验收批准依据/);
});
