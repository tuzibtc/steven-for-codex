#!/usr/bin/env node

import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { digest, boundedPath } from './lib/state.mjs';

const pluginRoot = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const errors = [];
const warnings = [];

async function exists(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
let manifest;
try {
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  errors.push(`插件清单无效：${error.message}`);
}

const rootName = path.basename(pluginRoot);
const parentName = path.basename(path.dirname(pluginRoot));
if (manifest?.name !== rootName && manifest?.name !== parentName) {
  errors.push("插件目录名必须与清单 name 一致，或位于同名插件的版本缓存目录中");
}
if (manifest?.skills !== "./skills/") errors.push("插件清单必须从 ./skills/ 发现 Skills");
if (!Array.isArray(manifest?.interface?.defaultPrompt) || manifest.interface.defaultPrompt.length === 0) {
  errors.push("插件清单缺少中文起始提示");
}

const skillsRoot = path.join(pluginRoot, "skills");
const skillDirs = (await readdir(skillsRoot, { withFileTypes: true }).catch(() => []))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const names = new Set();
const descriptions = new Set();
const referenceRoot = path.join(pluginRoot, 'references');

async function checkLinks(relative, body) {
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(https?:|#)/.test(m[1])) continue;
    const target = path.relative(pluginRoot,path.resolve(pluginRoot,path.dirname(relative),m[1].split('#')[0]));
    try { await boundedPath(pluginRoot,target); }
    catch { errors.push(`引用不存在或越界：${relative} -> ${m[1]}`); }
  }
}

for (const dir of skillDirs) {
  const skillPath = path.join(skillsRoot, dir, "SKILL.md");
  const yamlPath = path.join(skillsRoot, dir, "agents", "openai.yaml");
  const text = await readFile(skillPath, "utf8").catch(() => "");
  if (!text) {
    errors.push(`${dir} 缺少 SKILL.md`);
    continue;
  }
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  const name = frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
  const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1]?.replace(/^['"]|['"]$/g, "");
  if (name !== dir) errors.push(`${dir} 的 name 与目录名不一致`);
  if (!description) errors.push(`${dir} 缺少 description`);
  if (names.has(name)) errors.push(`重复 Skill 名：${name}`);
  if (descriptions.has(description)) errors.push(`重复 Skill 描述：${description}`);
  names.add(name);
  descriptions.add(description);
  if (/\bTODO\b|\[TODO/i.test(text)) errors.push(`${dir} 仍包含 TODO`);
  if (!(await exists(yamlPath))) errors.push(`${dir} 缺少 agents/openai.yaml`);
  else {
    const yaml = await readFile(yamlPath, "utf8");
    if (!yaml.includes(`$${dir}`)) errors.push(`${dir} 的默认提示未显式引用 $${dir}`);
  }
  await checkLinks(path.relative(pluginRoot,skillPath),text);
}

// Shared references have their own links; validating only SKILL.md misses a second-hop break.
for (const name of await readdir(referenceRoot).catch(()=>[])) {
  if (!name.endsWith('.md')) continue;
  const relative = `references/${name}`;
  const body = await readFile(path.join(pluginRoot, relative),'utf8');
  await checkLinks(relative,body);
}

async function fingerprint(root) {
  const files=[];
  async function visit(relative='') {
    for(const e of await readdir(path.join(root,relative),{withFileTypes:true})) {
      const p=path.join(relative,e.name);
      if(e.isDirectory())await visit(p);
      else if(e.isFile()){const bytes=await readFile(await boundedPath(root,p));files.push({path:p,digest:digest(bytes),bytes:bytes.length});}
      else throw new Error('不支持特殊文件或符号链接');
    }
  }
  await visit();return files.sort((a,b)=>a.path.localeCompare(b.path));
}
const compareArg=process.argv.find(v=>v.startsWith('--compare='))?.slice('--compare='.length);
let files=[], comparison=null;
try {
  files=await fingerprint(pluginRoot);
  if(compareArg){const other=await fingerprint(path.resolve(compareArg));const actual=new Map(other.map(f=>[f.path,f.digest]));
    const differences=files.filter(f=>actual.get(f.path)!==f.digest).map(f=>f.path);
    const ours=new Set(files.map(f=>f.path));differences.push(...other.filter(f=>!ours.has(f.path)).map(f=>f.path));
    comparison={matches:differences.length===0,differences};if(differences.length)errors.push('源码与目标副本文件集合或摘要不一致');}
}catch{errors.push('无法安全枚举插件文件摘要');}

if (!names.has("steven")) errors.push("缺少 steven 路由 Skill");
if (!names.has("steven-visual-design")) errors.push("缺少视觉设计 Skill");
if (!names.has("steven-design-review")) errors.push("缺少设计审查 Skill");

const forbiddenRoots = ["src", "dist", "native", "bin", "node_modules"];
for (const name of forbiddenRoots) {
  if (await exists(path.join(pluginRoot, name))) warnings.push(`插件中出现不应存在的大型运行时目录：${name}`);
}

const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
const hooksPath = path.join(codexHome, "hooks.json");
const hooksText = await readFile(hooksPath, "utf8").catch(() => "");
if (
  hooksText.includes("/史蒂文/.agents/skills/steven/")
  || (hooksText.includes("run-local-runtime.mjs") && hooksText.includes("install:codex-hooks"))
) {
  errors.push("检测到旧版史蒂文机械运行时挂钩；必须移除旧全局入口后再使用原生插件");
}

const result = {
  valid: errors.length === 0,
  skillCount: skillDirs.length,
  errors,
  warnings,
  files,
  comparison,
  evidenceLevel: '文件与配置；不证明实际加载或行为',
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.valid ? 0 : 1;
