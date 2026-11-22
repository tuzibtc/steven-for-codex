#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { object,text,hasSecret,issue,parse } from './lib/state.mjs';
const args=process.argv.slice(2), file=args.find(v=>!v.startsWith('--'));
const issues=[];
let value=null;
if(!file)issues.push(issue('ARGUMENT','需要最小只读补充包路径'));
else try{const p=parse(await readFile(file,'utf8'),'恢复包');value=p.value;issues.push(...p.issues);}catch{issues.push(issue('FILE_UNREADABLE','无法读取补充包'));}
let complete=false;
if(value){
 for(const key of ['schemaVersion','kind','capturedAt','readOnly','source','fieldCatalog','demands'])if(!Object.hasOwn(value,key))issues.push(issue('FIELD_MISSING',`缺少顶层字段：${key}`));
 if(value.schemaVersion!=='1')issues.push(issue('SCHEMA_UNKNOWN','schemaVersion 未支持'));
 if(value.kind!=='steven-github-readonly-recovery-slice')issues.push(issue('KIND','kind 不正确'));
 if(value.readOnly!==true)issues.push(issue('READONLY_REQUIRED','补充包必须明确 readOnly=true'));
 if(!text(value.capturedAt)||!Number.isFinite(Date.parse(value.capturedAt)))issues.push(issue('CAPTURED_AT','采集时间必须是可解析的时间文本'));
 if(!text(value.source?.owner)||!text(value.source?.repository)||!text(value.source?.projectId))issues.push(issue('SOURCE_IDENTITY','来源仓库或项目身份不完整'));
 if(!Array.isArray(value.fieldCatalog))issues.push(issue('FIELD_CATALOG','字段目录必须是数组'));
 const fieldIds=new Set();
 for(const f of Array.isArray(value.fieldCatalog)?value.fieldCatalog:[]){
  if(!object(f)||!text(f.id)||!text(f.name)||fieldIds.has(f.id))issues.push(issue('FIELD_IDENTITY','字段目录含无效或重复身份'));
  else fieldIds.add(f.id);
 }
 if(!Array.isArray(value.demands)||!value.demands.length)issues.push(issue('DEMANDS','需求记录不能为空数组以外的类型或空集'));
 const ids=new Set(),numbers=new Set(),urls=new Set();
 let recordsComplete=true;
 for(const [index,d]of (Array.isArray(value.demands)?value.demands:[]).entries()){
  if(!object(d)){issues.push(issue('DEMAND_OBJECT',`需求 ${index+1} 必须是对象`));recordsComplete=false;continue;}
  for(const key of ['kind','issueId','number','url','title','githubState','fields'])if(!Object.hasOwn(d,key))issues.push(issue('DEMAND_FIELD',`需求 ${index+1} 缺少：${key}`));
  if(!text(d.issueId)||ids.has(d.issueId))issues.push(issue('DEMAND_IDENTITY','需求身份缺失或重复'));ids.add(d.issueId);
  if(!Number.isSafeInteger(d.number)||d.number<1||!object(d.fields))issues.push(issue('DEMAND_TYPE','需求编号或字段类型错误'));
  if(!text(d.kind)||!text(d.title)||!text(d.githubState))issues.push(issue('DEMAND_TYPE','需求类别、标题和平台状态必须是非空文本'));
  if(text(d.kind)&&!['source','undertaking'].includes(d.kind))issues.push(issue('DEMAND_KIND_UNKNOWN','保留未知需求类别，须核对来源含义','warning'));
  if(numbers.has(d.number)||!text(d.url)||urls.has(d.url))issues.push(issue('DEMAND_IDENTITY','同一来源包的需求编号或链接缺失、重复'));
  numbers.add(d.number);urls.add(d.url);
  const c=d.coverage;
  const cOK=object(c)&&c.bodyComplete===true&&c.commentsComplete===true&&c.hasNextPage===false
   && typeof d.body==='string'&&Array.isArray(d.comments)&&Number.isSafeInteger(c.totalComments)&&c.totalComments===d.comments.length
   && d.comments.every(v=>object(v)&&text(v.id)&&typeof v.body==='string')
   &&new Set(d.comments.map(v=>v.id)).size===d.comments.length;
  if(!cOK)recordsComplete=false;
 }
 complete=recordsComplete&&Array.isArray(value.demands)&&value.demands.length>0&&!issues.some(i=>i.level==='error')&&value.coverage?.demandsComplete===true&&value.coverage?.fieldsComplete===true&&value.coverage?.hasNextPage===false;
 if(!complete)issues.push(issue('COVERAGE_UNKNOWN','正文、评论或分页覆盖不全；不能声称完整读取',args.includes('--require-complete')?'blocked':'warning'));
 if(hasSecret(value))issues.push(issue('SECRET','发现疑似凭据'));
 for(const k of Object.keys(value))if(!['schemaVersion','kind','capturedAt','readOnly','source','fieldCatalog','demands','coverage'].includes(k))issues.push(issue('EXTENSION',`保留未知字段：${k}`,'warning'));
}
const valid=!issues.some(i=>i.level==='error'),allowed=valid&&!issues.some(i=>i.level==='blocked');
complete&&=valid;
console.log(JSON.stringify({valid,allowed,complete,issues,errors:issues.filter(i=>i.level==='error').map(i=>i.message),warnings:issues.filter(i=>i.level==='warning').map(i=>i.message),
 summary:{demandCount:Array.isArray(value?.demands)?value.demands.length:0,readOnly:value?.readOnly===true}},null,2));
process.exitCode=allowed?0:1;
