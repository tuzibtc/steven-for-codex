import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(import.meta.dirname, "..");
const validator = path.join(pluginRoot, "scripts", "validate-plugin.mjs");

test("标准插件、专业 Skills 和共享引用完整", () => {
  const run = spawnSync(process.execPath, [validator, pluginRoot], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.valid, true);
  assert.equal(result.skillCount, 13);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
});

test("版本缓存目录中的安装副本也能独立校验", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "steven-installed-plugin-"));
  const versionedRoot = path.join(sandbox, "steven", "0.1.0+codex.test");
  try {
    await cp(pluginRoot, versionedRoot, { recursive: true });
    const run = spawnSync(process.execPath, [validator, versionedRoot], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).valid, true);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("旧版机械运行时挂钩不会在删除实现后继续污染新任务", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "steven-legacy-hook-"));
  try {
    await mkdir(sandbox, { recursive: true });
    await writeFile(path.join(sandbox, "hooks.json"), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{
          command: "/example/史蒂文/.agents/skills/steven/scripts/run-local-runtime.mjs install:codex-hooks",
        }],
      },
    }));
    const run = spawnSync(process.execPath, [validator, pluginRoot], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: sandbox },
    });
    assert.equal(run.status, 1, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\n"), /旧版史蒂文机械运行时挂钩/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("技能正文引用和共享引用均限于插件内，合法片段链接不误拒", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "steven-plugin-links-"));
  const copied = path.join(sandbox, "steven");
  try {
    await cp(pluginRoot, copied, { recursive: true });
    await writeFile(path.join(sandbox, "outside.md"), "合成的插件外资料，不是技能依赖\n");
    const skill = path.join(copied, "skills", "steven", "SKILL.md");
    await appendFile(skill, "\n[越界依赖](../../references/../../outside.md)\n");
    const escaped = spawnSync(process.execPath, [validator, copied], { encoding: "utf8" });
    assert.equal(escaped.status, 1, escaped.stdout);
    assert.match(JSON.parse(escaped.stdout).errors.join("\n"), /引用不存在或越界/);
    await cp(path.join(pluginRoot, "skills", "steven", "SKILL.md"), skill);
    await appendFile(skill, "\n[合法章节](../../references/project-truth.md#读取与持续履职)\n");
    const valid = spawnSync(process.execPath, [validator, copied], { encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    await appendFile(skill, "\n[失效的同目录方法](missing.md)\n");
    const missing = spawnSync(process.execPath, [validator, copied], { encoding: "utf8" });
    assert.equal(missing.status, 1, missing.stdout);
    assert.match(JSON.parse(missing.stdout).errors.join("\n"), /引用不存在或越界/);
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
