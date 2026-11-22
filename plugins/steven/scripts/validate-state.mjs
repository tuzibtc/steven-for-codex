#!/usr/bin/env node
import path from 'node:path';
import { loadProject } from './lib/state.mjs';
const args=process.argv.slice(2);
const option=name=>args.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3);
const root=path.resolve(args.find(v=>!v.startsWith('--'))??process.cwd());
const result=await loadProject(root,{action:option('action')??'read',iterationId:option('iteration'),version:option('version')});
const {state,project,...safe}=result;
console.log(JSON.stringify(safe,null,2));
process.exitCode=result.valid&&result.allowed?0:1;
