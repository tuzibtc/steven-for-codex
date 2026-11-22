import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const created = [];
async function trackedTemp(prefix) { const root = await mkdtemp(prefix); created.push(root); return root; }
test.after(async () => { for (const root of created) await rm(root, { recursive: true, force: true }); });

const inspector = path.resolve(import.meta.dirname, "../scripts/inspect-project.mjs");

function git(root, args) {
  const run = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
}

async function fixture() {
  const root = await trackedTemp(path.join(tmpdir(), "steven-fault-recovery-"));
  await mkdir(path.join(root, ".steven", "state"), { recursive: true });
  await mkdir(path.join(root, "产品文档"), { recursive: true });
  const current = "产品文档/演示_PRD_v0.1_定稿.md";
  await writeFile(path.join(root, "AGENTS.md"), "# 隔离测试\n");
  await writeFile(path.join(root, current), "# 演示 PRD v0.1\n");
  await writeFile(path.join(root, ".steven", "project.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_fault", prd: { current, lifecycle: "定稿" } }));
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_fault", sourceDemands: [], projectDemands: [], prd: { current, lifecycle: "定稿" } }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fault@example.invalid"]);
  git(root, ["config", "user.name", "Fault Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "baseline"]);
  return { root, current };
}

function inspect(root, extra = []) {
  return spawnSync(process.execPath, [inspector, root, ...extra], { encoding: "utf8" });
}

test("定稿正文被误改后完成发现、阻断、恢复和全量复读", async () => {
  const { root, current } = await fixture();
  await appendFile(path.join(root, current), "越权修改\n");
  const blocked = inspect(root);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /存在未提交改动/);
  git(root, ["restore", "--", current]);
  const recovered = inspect(root);
  assert.equal(recovered.status, 0, recovered.stdout);
  assert.deepEqual(JSON.parse(recovered.stdout).warnings, []);
});

test("本地 PRD 指针漏改后完成发现、阻断、补齐和复读", async () => {
  const { root, current } = await fixture();
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_fault", sourceDemands: [], projectDemands: [], prd: { current: "产品文档/错误.md", lifecycle: "定稿" } }));
  const blocked = inspect(root);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stdout, /PRD 指针不一致/);
  await writeFile(path.join(root, ".steven", "state", "authorized.json"), JSON.stringify({ schemaVersion: "2", projectId: "project_fault", sourceDemands: [], projectDemands: [], prd: { current, lifecycle: "定稿" } }));
  const recovered = inspect(root);
  assert.equal(recovered.status, 0, recovered.stdout);
});
