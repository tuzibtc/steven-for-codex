// Structural checks only. Product behavior is exercised by state/fault tests and isolated Agent runs.
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
const root=path.resolve(import.meta.dirname,'..');
test('专业入口与共享引用形成可达文档图，无断链或越界引用',async()=>{
 const files=[...(await readdir(path.join(root,'references'))).filter(f=>f.endsWith('.md')).map(f=>'references/'+f),
 ...(await readdir(path.join(root,'skills'))).map(f=>'skills/'+f+'/SKILL.md')];
 const referenced=new Set();
 for(const rel of files){const source=await readFile(path.join(root,rel),'utf8');
 for(const m of source.matchAll(/\]\(([^)]+)\)/g)){if(/^(https?:|#)/.test(m[1]))continue;
 const target=path.resolve(root,path.dirname(rel),m[1].split('#')[0]);assert(target.startsWith(root+path.sep),rel);
 await readFile(target);referenced.add(path.relative(root,target));}}
 for(const f of files.filter(f=>f.startsWith('references/')))assert(referenced.has(f),'孤立共享引用：'+f);
});
test('方法入口保持 13 项且不复制已退出的六章或全局浏览器流程',async()=>{
 const dirs=await readdir(path.join(root,'skills'));assert.equal(dirs.length,13);
 const prd=await readFile(path.join(root,'skills/steven-prd/SKILL.md'),'utf8');
 assert.doesNotMatch(prd,/所有项目使用同一套六章|六章要回答最低成立事实/);
 const browser=await readFile(path.join(root,'references/browser-safety.md'),'utf8');
 assert.doesNotMatch(browser,/优先使用内置浏览器/);
});
