import { open, readFile, rename, unlink, realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { boundedPath, digest, encode, loadProject, object, projectProjection, readPrdFile, text, validateState } from './state.mjs';

const fail = (code,message) => Object.assign(new Error(message),{ code });
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])) : value;
const targetDigest = value => digest(JSON.stringify(canonical(value)));

// A format migration must not silently discard facts already present in v2.
// Unknown identity is resolved by the exact path, never invented from a demand.
function preserveLegacyPrds(state, project, target) {
  if (state.schemaVersion !== '2') return;
  const reject = () => { throw fail('MIGRATION_PRD_PRESERVATION','旧格式 PRD 身份、路径、定稿摘要或既有关联未完整保留；先核对映射'); };
  for (const source of [state,project]) {
    const prior=source.prd;
    for (const key of ['current','draft']) {
      if (!prior?.[key]) continue;
      const id=key==='current'?prior.id:prior.draftId;
      const candidates=text(id)?[target.prds?.[id]]:Object.values(target.prds??{}).filter(p=>p?.path===prior[key]);
      const after=candidates.length===1?candidates[0]:null;
      if (!after || after.path!==prior[key] || after.lifecycle!==(key==='current'?prior.lifecycle:prior.draftLifecycle)) reject();
      if (key==='current' && prior.contentDigest && after.contentDigest!==prior.contentDigest) reject();
    }
  }
  for (const prior of state.projectDemands??[]) {
    if (!text(prior.prdId)) continue;
    const after=target.projectDemands?.find(d=>d.projectDemandId===prior.projectDemandId);
    if (!Object.hasOwn(target.prds??{},prior.prdId) || after?.prdId!==prior.prdId) reject();
  }
}

// Carry only unresolved facts, never a growing operation history. Evidence content
// remains the Agent's responsibility; a predecessor ID is not resolution evidence.
function preserveUnresolved(previous, next, resume) {
  if (!object(next)) throw fail('TARGET_IDENTITY','候选必须包含操作记录');
  if (resume) {
    if (next.unresolved === undefined && previous?.unresolved !== undefined) next.unresolved = structuredClone(previous.unresolved);
    if (object(next.unresolved) && Object.keys(next.unresolved).length === 0) delete next.unresolved;
    return;
  }
  const pending = new Map(Object.entries(previous?.unresolved ?? {}));
  if (previous?.status && previous.status !== 'completed') {
    const prior = structuredClone(previous);
    delete prior.unresolved; delete prior.resolvedOperationReferences;
    pending.set(prior.operationId,prior);
  }
  if (pending.has(next.operationId)) throw fail('OPERATION_CONFLICT','新的状态写入不能复用未解决操作身份');
  const resolutions = next.resolvedOperationReferences ?? {};
  if (!object(resolutions)) throw fail('OPERATION_RESOLUTION','解决依据必须按原操作身份记录');
  const assignments = next.operationScopeAssignments ?? {};
  if (!object(assignments)) throw fail('OPERATION_SCOPE','影响范围补记必须按原操作身份记录');
  for (const [id, assignment] of Object.entries(assignments)) {
    const prior = pending.get(id);
    const ids = assignment?.affectedIterationIds;
    if (!prior || prior.affectedIterationIds?.length || Object.hasOwn(resolutions,id)
        || !object(assignment) || !Array.isArray(ids) || !ids.length
        || !ids.every(text) || new Set(ids).size !== ids.length
        || !text(assignment.evidenceReference)) {
      throw fail('OPERATION_SCOPE','仅可凭证据为未解决且未定范围的原操作补记归属');
    }
    pending.set(id,{...prior,affectedIterationIds:ids,scopeEvidenceReference:assignment.evidenceReference});
  }
  for (const [id, reference] of Object.entries(resolutions)) {
    if (!pending.has(id) || !text(reference)) throw fail('OPERATION_RESOLUTION','解决依据须对应尚未解决的原操作，且引用不可为空');
    pending.delete(id);
  }
  const carried = Object.fromEntries(pending);
  if (next.unresolved !== undefined && targetDigest(next.unresolved) !== targetDigest(carried)) throw fail('OPERATION_EVIDENCE_CHANGED','不能删改待核查操作的原范围、回执或恢复证据');
  if (pending.size) next.unresolved = structuredClone(carried);
  else delete next.unresolved;
}

// One authoritative rename followed by a derived projection, NOT a two-file transaction.
// checkpoint is an injectable local I/O boundary for deterministic crash tests; no network work.
export async function commitState({ root, expected, nextState, operationId, checkpoint = async () => {} }) {
  let lock, lockPath, owned = false, committed = false;
  const nonce = randomUUID();
  const temporary = new Set();
  let phase = 'preflight';
  const result = (ok,code,message,extra={}) => ({ ok,code,message,phase,committed,...extra });
  try {
    if (!text(operationId) || !object(expected) || !text(expected.stateDigest) || !text(expected.projectDigest) || !Number.isSafeInteger(expected.revision)) throw fail('EXPECTED_REQUIRED','必须提供操作身份、两个写前摘要与修订');
    if (!object(nextState) || nextState.schemaVersion !== '3') throw fail('SCHEMA_WRITE','仅允许明确的 schema 3 候选写入');
    const base = await realpath(root);
    lockPath = await boundedPath(base,'.steven/state/write.lock',{missing:true});
    try { lock = await open(lockPath,'wx',0o600); owned = true; }
    catch (e) { if (e.code === 'EEXIST') throw fail('LOCKED','另一个写入持有锁；不得按锁年龄抢占'); throw e; }
    await lock.writeFile(encode({ operationId, nonce })); await lock.sync();
    phase = 'locked'; await checkpoint(phase);
    await verifyLock();
    const current = await loadProject(base);
    // A partial projection is readable. Corrupt authoritative input is never overwritten.
    const migrationResume = current.state?.schemaVersion === '3' && current.project?.schemaVersion === '2'
      && current.state.lastOperation?.operationId === operationId && current.state.lastOperation?.localWrite
      && text(current.state.lastOperation.migrationApprovalReference);
    if (!current.state || !current.project || current.issues.some(i=>i.level==='error' && !(migrationResume && i.code==='SCHEMA_MISMATCH'))) throw fail('BASELINE_INVALID','当前状态不可安全读取或结构无效');
    const payload = structuredClone(nextState);
    if (payload.lastOperation) delete payload.lastOperation.localWrite;
    const receipt = current.state.lastOperation?.localWrite;
    const sameOperation = current.state.lastOperation?.operationId === operationId && receipt;
    preserveUnresolved(current.state.lastOperation,payload.lastOperation,sameOperation);
    const intent = targetDigest(payload);
    let target;
    if (sameOperation) {
      if (receipt.targetDigest !== intent || receipt.baseStateDigest !== expected.stateDigest || receipt.baseProjectDigest !== expected.projectDigest || receipt.baseRevision !== expected.revision) throw fail('OPERATION_CONFLICT','同一操作身份不能换目标或写前基线');
      target = current.state;
      const proof = structuredClone(target); delete proof.lastOperation.localWrite;
      if (targetDigest(proof) !== intent) throw fail('RESUME_STATE_CHANGED','权威内容已经改变，不能用旧操作覆盖');
      committed = true;
    } else {
      if (current.stateDigest !== expected.stateDigest || current.projectDigest !== expected.projectDigest || (current.state.revision ?? 0) !== expected.revision) throw fail('STALE_BASELINE','写前基线已改变，必须重读并重新计算');
      if (current.state.schemaVersion !== '3' && !text(payload.lastOperation?.migrationApprovalReference)) throw fail('MIGRATION_AUTHORITY','旧格式转换缺少明确迁移批准引用');
      if (payload.projectId !== current.state.projectId || payload.revision !== expected.revision+1 || payload.lastOperation?.operationId !== operationId) throw fail('TARGET_IDENTITY','候选项目、修订或操作身份不一致');
      target = { ...payload, lastOperation:{...payload.lastOperation, localWrite:{
        targetDigest:intent, baseStateDigest:expected.stateDigest, baseProjectDigest:expected.projectDigest, baseRevision:expected.revision,
      }} };
      const validation = validateState(target,projectProjection(target,current.project));
      if (!validation.valid) throw fail('TARGET_INVALID','候选状态未通过结构检查');
      preserveLegacyPrds(current.state,current.project,target);
      for (const [id, prior] of Object.entries(current.state.prds ?? {})) {
        if (prior.lifecycle !== '定稿') continue;
        const after = target.prds[id];
        if (!after || after.contentDigest !== prior.contentDigest || after.lifecycle !== prior.lifecycle || after.iterationId !== prior.iterationId) throw fail('FROZEN_PRD','定稿身份或内容事实不能被原地替换/删除');
        if (after.path !== prior.path) {
          const move = Array.isArray(target.lastOperation.pathMoves) && target.lastOperation.pathMoves.find(m=>m?.prdId===id&&m.from===prior.path&&m.to===after.path);
          if (!move || !text(move.approvalReference) || path.basename(after.path)!==path.basename(prior.path)) throw fail('FROZEN_PATH','定稿纯路径迁移缺少精确批准或改变文件名');
        }
      }
      // Check all candidate files/digests without ever persisting a draft as authority.
      for (const [id,p] of Object.entries(target.prds)) {
        const {bytes} = await readPrdFile(base,target,id,p);
        if (p.contentDigest && digest(bytes) !== p.contentDigest) throw fail('TARGET_PRD_DIGEST','候选 PRD 摘要不符');
      }
      const oldOperation = current.state.lastOperation;
      if (oldOperation?.status && oldOperation.status !== 'completed' && payload.lastOperation.previousOperationId !== oldOperation.operationId) throw fail('OPERATION_UNRESOLVED','未承接原未完成操作，不得覆盖恢复证据');
      await replace('.steven/state/authorized.json',encode(target),current.stateDigest);
      committed = true; phase = 'authority-written'; await checkpoint(phase);
    }
    const derived = projectProjection(target,current.project);
    const derivedBytes = encode(derived);
    const projectFile = await boundedPath(base,'.steven/project.json');
    const actualProject = await readFile(projectFile,'utf8');
    if (actualProject !== derivedBytes) {
      if (digest(actualProject) !== expected.projectDigest) throw fail('PROJECTION_CONFLICT','入口已被其它上下文修改，保留权威事实并请求对齐');
      await replace('.steven/project.json',derivedBytes,expected.projectDigest);
    }
    phase = 'projection-written'; await checkpoint(phase);
    await verifyLock();
    const check = await loadProject(base);
    if (!check.valid || check.issues.some(i=>i.code==='PROJECTION_MISMATCH' || i.code==='COMPAT_PROJECTION') || check.stateDigest !== digest(encode(target))) throw fail('READBACK_MISMATCH','写后全量回读不一致');
    phase = 'verified';
    return result(true,sameOperation?'RESUMED':'WRITTEN','本地权威与导航已回读；不代表外部投影或产品批准完成',{ revision:target.revision,stateDigest:check.stateDigest,projectDigest:check.projectDigest });

    async function replace(relative,bytes,expectedDigest) {
      const file = await boundedPath(base,relative);
      if (digest(await readFile(file)) !== expectedDigest) throw fail('STALE_BASELINE','锁内发现非协作写入，拒绝覆盖');
      const tmp = `${file}.${nonce}.tmp`;
      const handle = await open(tmp,'wx',0o600); temporary.add(tmp);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await checkpoint(`before-rename:${relative}`);
      await verifyLock();
      if (await boundedPath(base,relative) !== file || digest(await readFile(file)) !== expectedDigest) throw fail('STALE_BASELINE','提交前路径或内容变化');
      await rename(tmp,file); temporary.delete(tmp);
      // A directory sync failure after rename must not report the authority unchanged.
      if (relative === '.steven/state/authorized.json') committed = true;
      await checkpoint(`after-rename:${relative}`);
      const directory = await open(path.dirname(file),'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    async function verifyLock() {
      try {
        if (await boundedPath(base,'.steven/state/write.lock') !== lockPath) throw Error('changed');
        const [held,current] = await Promise.all([lock.stat(),stat(lockPath)]);
        const content = JSON.parse(await readFile(lockPath,'utf8'));
        if (held.dev !== current.dev || held.ino !== current.ino || content.nonce !== nonce || content.operationId !== operationId) throw Error('changed');
      } catch { throw fail('LOCK_LOST','排他锁已丢失或被替换，停止写入并保留现场'); }
    }
  } catch (e) {
    return result(false,e.code ?? 'IO_ERROR',committed ? '权威已写入，投影/回读未完成；沿原操作恢复，禁止重放外部副作用' : '本地操作未完成；保留基线，不宣布成功', { detail:e.code ? e.message : '本地读写失败' });
  } finally {
    for (const tmp of temporary) await unlink(tmp).catch(()=>{});
    if (owned && lockPath && lock) {
      // Never delete another writer's lock if somebody replaced it outside this protocol.
      try {
        const [held,current]=await Promise.all([lock.stat(),lstat(lockPath)]);
        if (current.isFile() && held.dev===current.dev && held.ino===current.ino) {
          const receipt=JSON.parse(await readFile(lockPath,'utf8'));
          if (receipt.nonce===nonce && receipt.operationId===operationId) await unlink(lockPath);
        }
      } catch { /* absent/changed lock is not ours */ }
    }
    if (lock) await lock.close().catch(()=>{});
  }
}

// Migration never infers scope or approvals from old arrays. The Agent must resolve the mapping.
export function migrateLegacy(state, project, mapping) {
  if (state?.schemaVersion !== '2' || project?.schemaVersion !== '2') return { ok:false,code:'NOT_LEGACY' };
  if (!object(mapping) || !text(mapping.approvalReference) || !object(mapping.iterations) || !object(mapping.prds) || !object(mapping.demands)) return { ok:false,code:'MIGRATION_EVIDENCE_REQUIRED' };
  if (!Array.isArray(state.projectDemands) || state.projectDemands.some(d=>!object(d) || !text(d.projectDemandId))) return {ok:false,code:'MIGRATION_SOURCE_INVALID'};
  const sourceIds = (Array.isArray(state.projectDemands)?state.projectDemands:[]).map(d=>d.projectDemandId);
  if (sourceIds.length!==Object.keys(mapping.demands).length || sourceIds.some(id=>!Object.hasOwn(mapping.demands,id))) return {ok:false,code:'MIGRATION_SCOPE_MISMATCH'};
  if (state.projectId !== project.projectId || !text(mapping.operationId) || (mapping.currentIterationId !== null && !text(mapping.currentIterationId)) || sourceIds.some(id=>!object(mapping.demands[id]) || !text(mapping.demands[id].iterationId) || (mapping.demands[id].prdId !== null && !text(mapping.demands[id].prdId)))) return {ok:false,code:'MIGRATION_MAPPING_INVALID'};
  const next = { ...structuredClone(state), schemaVersion:'3', revision:1,
    currentIterationId:mapping.currentIterationId, iterations:structuredClone(mapping.iterations),prds:structuredClone(mapping.prds),
    projectDemands:state.projectDemands.map(d=>({...d,iterationId:mapping.demands[d.projectDemandId].iterationId,prdId:mapping.demands[d.projectDemandId].prdId})),
    lastOperation:{operationId:mapping.operationId,status:'completed',kind:'local-migration',migrationApprovalReference:mapping.approvalReference,previousOperationId:state.lastOperation?.operationId??null},
  };
  delete next.prd; // legacy compatibility copy is replaced by the derived project navigation
  try { preserveLegacyPrds(state,project,next); }
  catch (e) { return {ok:false,code:e.code,detail:e.message}; }
  const projected=projectProjection(next,project);
  const check=validateState(next,projected);
  return {ok:check.valid,code:check.valid?'MIGRATION_CANDIDATE':'MIGRATION_INVALID',state:next,project:projected,issues:check.issues};
}
