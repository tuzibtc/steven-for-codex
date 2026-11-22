#!/usr/bin/env node
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { boundedPath,digest,loadProject,projectProjection,issue } from './lib/state.mjs';

const args=process.argv.slice(2);
const option=name=>args.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const requested=path.resolve(args.find(v=>!v.startsWith('--'))??process.cwd());
const git=(argv,cwd=requested)=>{try{return execFileSync('git',['-C',cwd,...argv],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{return null;}};
const gitRoot=git(['rev-parse','--show-toplevel']);
// Git ownership and Steven project ownership need not share a root. A partial
// or damaged local entry must produce its own diagnostic, not fall back to a parent.
let root=requested;
const boundary=gitRoot?await realpath(gitRoot):null;
for(let dir=requested;;dir=path.dirname(dir)){
 const marker=await lstat(path.join(dir,'.steven')).then(()=>true,()=>false);
 if(marker){root=dir;break;}
 if(!boundary || await realpath(dir).catch(()=>null)===boundary || dir===path.dirname(dir))break;
 root=path.dirname(dir);
}
const loaded=await loadProject(root,{action:option('action')??'read',iterationId:option('iteration'),version:option('version')});
const {state,project}=loaded;
const selectedId=option('iteration')??state?.currentIterationId;
const selected=typeof selectedId==='string'&&state?.iterations&&Object.hasOwn(state.iterations,selectedId)?state.iterations[selectedId]:null;
const navigationState=state?.schemaVersion==='3' ? {...state,currentIterationId:selectedId,
 ...(option('action')==='maintain'&&selected?{iterations:{...state.iterations,[selectedId]:{...selected,currentPrdId:selected.maintenance?.prdId??null,draftPrdId:null}}}:{}),
}:state;
const nav=state?.schemaVersion==='3'?projectProjection(navigationState,project??{}):project;
const configured=nav?.prd?.current??null,draft=nav?.prd?.draft??null;
let bytes=null,configuredPath=null;
if(configured)try{configuredPath=await boundedPath(root,configured);bytes=await readFile(configuredPath);}catch{}
const configuredStatus=configuredPath?git(['status','--porcelain=v1','--',configured],root):null;
const tracked=configuredPath?git(['ls-files','--error-unmatch','--',configured],root)!==null:false;
const commit=configuredPath?git(['log','-1','--format=%H','--',configured],root):null;
const actualDigest=bytes?digest(bytes):null;
const fileVersion=typeof configured==='string'?path.basename(configured).match(/v(\d+(?:\.\d+)*)/i)?.[1]??null:null;
const bodyVersion=bytes?.toString('utf8').slice(0,1200).match(/\bv(\d+(?:\.\d+)*)\b/i)?.[1]??null;
const issues=[...loaded.issues];
const add=(code,message,level='blocked')=>issues.push(issue(code,message,level));
if(!gitRoot)add('GIT_MISSING','当前目录不在 Git 仓库中','warning');
try{await boundedPath(root,'AGENTS.md');}catch{add('RULES_MISSING','项目根目录没有 AGENTS.md','warning');}
if(configuredStatus)add('PRD_DIRTY','当前生效 PRD 存在未提交改动');
if(configuredPath&&!tracked)add('PRD_UNTRACKED','当前生效 PRD 尚未纳入 Git');
if(configuredPath&&!commit)add('PRD_UNCOMMITTED','当前生效 PRD 尚未形成可恢复提交');
if(fileVersion&&bodyVersion&&fileVersion!==bodyVersion)add('PRD_VERSION','当前生效 PRD 的文件名与正文版本不一致');
const head=gitRoot?git(['rev-parse','HEAD'],root):null;
if(option('expected-head')&&option('expected-head')!==head)add('HEAD_CHANGED','项目基线已被其他上下文改变，必须重新读取并计算影响');
if(option('expected-digest')&&option('expected-digest')!==actualDigest)add('EXPECTED_DIGEST','当前 PRD 与预期摘要不一致');
const candidates=[];
// Discovery is recovery-only, bounded to this root and known documentation directories.
if(!project || (configured&&!bytes)){
 const visit=async(dir,depth)=>{if(depth>2||candidates.length>=30)return;const entries=await readdir(dir,{withFileTypes:true}).catch(()=>[]);
 for(const e of entries){const p=path.join(dir,e.name);if(e.isDirectory()&&['产品文档','docs','prd'].includes(e.name))await visit(p,depth+1);
 else if(e.isFile()&&/prd/i.test(e.name)&&/\.(md|txt|pdf|docx)$/i.test(e.name)&&candidates.length<30)candidates.push(path.relative(root,p));}};
 await visit(root,0);
}
const result={requestedPath:requested,projectRoot:root,
 git:{repository:Boolean(gitRoot),branch:gitRoot?git(['branch','--show-current'],root):null,head,expectedHead:option('expected-head')??null,worktreeStatus:gitRoot?(git(['status','--porcelain=v1'],root)?.split('\n').filter(Boolean)??[]):[]},
 steven:{projectFile:project?path.join(root,'.steven/project.json'):null,stateFile:state?path.join(root,'.steven/state/authorized.json'):null,projectId:state?.projectId??project?.projectId??null},
 prd:{configured,draft,configuredExists:Boolean(bytes),configuredGitStatus:configuredStatus||null,configuredTracked:tracked,configuredCommit:commit||null,configuredDigest:actualDigest,fileVersion,bodyVersion,candidates,finalizedCandidates:candidates.filter(p=>/定稿|final/i.test(p)),effective:nav?.prd?.effective===true},
 validation:{valid:loaded.valid,action:loaded.action,allowed:loaded.allowed&&!issues.some(i=>['error','blocked','unknown'].includes(i.level)),blocked:issues.filter(i=>i.level==='blocked'),unknown:issues.filter(i=>i.level==='unknown'),fileScope:loaded.fileScope},
 issues,warnings:issues.filter(i=>i.level!=='warning'||i.code!=='LEGACY_READONLY').map(i=>i.message)};
if(args.includes('--summary')){
 const untracked=result.git.worktreeStatus.filter(s=>s.startsWith('?? '));
 result.git.worktreeStatus=result.git.worktreeStatus.filter(s=>!s.startsWith('?? '));
 result.git.omittedUntracked={entries:untracked.length,details:'省略未跟踪路径；不带 --summary 查看完整状态，目录条目不等于文件数'};
}
console.log(JSON.stringify(result,null,2));
process.exitCode=issues.some(i=>['error','blocked','unknown'].includes(i.level))?2:0;
