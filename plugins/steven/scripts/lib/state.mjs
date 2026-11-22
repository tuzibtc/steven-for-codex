import { createHash } from 'node:crypto';
import { readFile, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const gitRead = (root, args) => promisify(execFile)('git', args, { cwd: root, encoding:'buffer', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });

export const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export const text = v => typeof v === 'string' && v.trim().length > 0;
export const digest = v => `sha256:${createHash('sha256').update(v).digest('hex')}`;
export const encode = v => `${JSON.stringify(v, null, 2)}\n`;
export const issue = (code, message, level = 'error', at = '') => ({ code, message, level, at });
export const hasSecret = v => [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:gh[opusr]_|github_pat_|sk-)[A-Za-z0-9_-]{20,}\b/,
  /["']?(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[=:]\s*["']?[^\s"',}]{8,}/i,
].some(p => p.test(typeof v === 'string' ? v : JSON.stringify(v)));

export function parse(textValue, label = '状态') {
  try {
    const value = JSON.parse(textValue);
    if (!object(value)) return { value: null, issues: [issue('OBJECT_REQUIRED', `${label} 必须是对象`, 'error', label)] };
    return { value, issues: [] };
  } catch {
    return { value: null, issues: [issue('INVALID_JSON', `${label} 无法读取或不是有效 JSON`, 'error', label)] };
  }
}

// Resolve an existing target or a missing final basename; never follow an escape.
export async function boundedPath(root, relative, { missing = false } = {}) {
  if (!text(relative) || path.isAbsolute(relative) || relative.includes('\0')) throw Object.assign(new Error('路径必须是项目内相对路径'), { code: 'PATH_BOUNDARY' });
  const base = await realpath(root);
  const target = path.resolve(base, relative);
  const inside = p => p !== base && p.startsWith(base + path.sep);
  if (!inside(target)) throw Object.assign(new Error('路径越出项目或指向根目录'), { code: 'PATH_BOUNDARY' });
  const parent = await realpath(path.dirname(target));
  if (!inside(parent) && parent !== base) throw Object.assign(new Error('符号链接父路径越出项目'), { code: 'PATH_BOUNDARY' });
  try {
    const stat = await lstat(target);
    const actual = await realpath(target);
    if (!inside(actual) || !stat.isFile()) throw Object.assign(new Error('目标不是项目内普通文件（不允许符号链接）'), { code: 'PATH_BOUNDARY' });
    return actual;
  } catch (e) {
    if (e.code === 'ENOENT' && missing) return path.join(parent, path.basename(target));
    throw e;
  }
}

const flowByStatus = {
  待处理: [null, undefined, ''], 研讨中: ['需求研讨','需求调研','需求文档','流程设计','功能架构','原型设计'],
  开发中: ['技术开发','视觉设计','产品验收'], 已实现: [null, undefined, '', '部署上线'], 已关闭: [null, undefined, ''],
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const record = (map, key) => typeof key === 'string' && Object.hasOwn(map,key) && object(map[key]);
const lookup = (map, key) => object(map) && record(map,key) ? map[key] : undefined;
const emptyPrd = () => ({ current: null, draft: null, lifecycle: '不存在', contentDigest: null });

export function projectProjection(state, previous = {}) {
  if (state.schemaVersion !== '3') throw new Error('仅 schema 3 可派生投影');
  const iteration = lookup(state.iterations,state.currentIterationId);
  const current = lookup(state.prds,iteration?.currentPrdId);
  const draft = lookup(state.prds,iteration?.draftPrdId);
  const prd = current || draft ? {
    current: current?.path ?? null, draft: draft?.path ?? null,
    lifecycle: current?.lifecycle ?? draft?.lifecycle ?? '不存在',
    contentDigest: current?.contentDigest ?? null,
    ...(current ? { id: iteration.currentPrdId, effective: current.effective === true } : {}),
    ...(draft ? { draftLifecycle: draft.lifecycle } : {}),
  } : emptyPrd();
  // Unrelated navigation extensions survive; authoritative fields are always derived.
  const metadata = Object.fromEntries(['software','technicalPlan'].filter(k=>Object.hasOwn(state,k)).map(k=>[k,structuredClone(state[k])]));
  return { ...previous, ...metadata, schemaVersion: '3', projectId: state.projectId, revision: state.revision,
    currentIterationId: state.currentIterationId, prd };
}

export function validateState(state, project, options = {}) {
  const issues = [];
  const add = (code, message, level = 'error', at = '') => issues.push(issue(code, message, level, at));
  const action = options.action ?? 'read';
  const writeAction = ['develop', 'maintain', 'accept'].includes(action);
  if (!['read','discuss','develop','maintain','accept'].includes(action)) add('ACTION_UNKNOWN','未知检查动作');
  if (!object(state) || !object(project)) {
    add('OBJECT_REQUIRED','两个状态文件必须均为对象');
    return outcome();
  }
  if (!['2','3'].includes(state.schemaVersion)) add('SCHEMA_UNKNOWN','authorized.json schemaVersion 未支持');
  if (state.schemaVersion !== project.schemaVersion) add('SCHEMA_MISMATCH','两个状态文件格式不一致');
  if (!text(state.projectId) || state.projectId !== project.projectId) add('PROJECT_ID','两个状态文件的 projectId 不一致或缺失');
  for (const [label, value] of [['authorized.json',state],['project.json',project]]) {
    if (hasSecret(value)) add('SECRET',`${label} 疑似包含秘密或访问令牌`);
  }
  const arrays = {};
  for (const key of ['sourceDemands','projectDemands']) {
    if (!Array.isArray(state[key])) add('ARRAY_REQUIRED',`${key} 必须是数组`);
    arrays[key] = Array.isArray(state[key]) ? state[key] : [];
  }
  const priorities = (v, at) => {
    if (!object(v) || !text(v.p) || !text(v.d) || !/^P[0-3]$/.test(v.p) || !/^D[0-3]$/.test(v.d)) add('PRIORITY',`${at} 的 P/D 必须分别为 P0-P3 与 D0-D3`);
  };
  const index = (values, key, label) => {
    const map = new Map();
    values.forEach((v, i) => {
      if (!object(v) || !text(v[key])) add('IDENTITY',`${label}[${i}] 缺少 ${key}`);
      else if (map.has(v[key])) add('IDENTITY_DUPLICATE',`${label} 重复身份 ${v[key]}`);
      else map.set(v[key],v);
    });
    return map;
  };
  const sources = index(arrays.sourceDemands,'sourceDemandId','sourceDemands');
  const demands = index(arrays.projectDemands,'projectDemandId','projectDemands');
  for (const [id, d] of sources) {
    priorities(d.initialPriority,id);
    if (!['repositoryId','projectId','issueId','projectItemId','url'].every(k => text(d.github?.[k]))) add('SOURCE_IDENTITY',`${id} 缺少 GitHub 来源身份或链接`);
  }
  for (const [id,d] of demands) {
    if (!sources.has(d.sourceDemandId)) add('SOURCE_MISSING',`${id} 引用了不存在的需求源`);
    priorities(d.priority,id);
    const status = d.business?.status;
    if (!text(status) || !Object.hasOwn(flowByStatus,status)) add('BUSINESS_STATUS',`${id} 的业务状态不在固定五种状态中`);
    else if (!flowByStatus[status].includes(d.business?.currentFlow)) add('BUSINESS_FLOW',`${id} 业务状态与当前流程不匹配`);
    if (status === '已实现' && !text(d.acceptance?.userApprovalReference)) add('ACCEPTANCE_MISSING',`${id} 没有用户验收批准依据`);
    if (state.schemaVersion === '2' && !text(d.prdId)) add('PRD_ID',`${id} 缺少关联 PRD 身份`);
  }
  if (state.schemaVersion === '2') {
    add('LEGACY_READONLY','旧格式只读兼容；新动作判定需证据化迁移，不自动补造批准','warning');
    for (const [label,v] of [['project.json',project],['authorized.json',state]]) {
      if (!object(v.prd) || !Object.hasOwn(v.prd,'current')) add('PRD_POINTER',`${label} 缺少现行 PRD 指针`);
      if (v.prd?.current && v.prd.lifecycle !== '定稿') add('PRD_LIFECYCLE',`${label} 现行 PRD 必须为定稿`);
      if (!v.prd?.current && v.prd?.contentDigest) add('PRD_DIGEST',`${label} 没有现行 PRD 时不得保留摘要`);
      if (v.prd?.draft && !['碎片','草稿'].includes(v.prd.draftLifecycle)) add('DRAFT_LIFECYCLE',`${label} 在编生命周期错误`);
      if (!v.prd?.current && !v.prd?.draft && v.prd?.lifecycle !== '不存在') add('PRD_LIFECYCLE',`${label} 无 PRD 时应为不存在`);
    }
    if (state.prd?.current !== project.prd?.current || (state.prd?.draft ?? null) !== (project.prd?.draft ?? null)) add('PROJECTION_MISMATCH','两个状态文件的当前 PRD 指针不一致');
    if (writeAction) add('LEGACY_ACTION_UNKNOWN','旧格式缺少本动作所需完整证据','unknown');
    return outcome();
  }
  if (state.schemaVersion !== '3') return outcome();
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) add('REVISION','revision 必须为非负安全整数');
  for (const key of ['iterations','prds']) if (!object(state[key])) add('MAP_REQUIRED',`${key} 必须是身份索引对象`);
  const iterations = object(state.iterations) ? state.iterations : {};
  const prds = object(state.prds) ? state.prds : {};
  const operation = state.lastOperation;
  const operations = operation == null ? [] : [operation];
  if (object(operation) && operation.unresolved !== undefined) {
    if (!object(operation.unresolved)) add('OPERATION_TYPE','未解决操作必须为身份索引');
    else for (const [id, prior] of Object.entries(operation.unresolved)) {
      operations.push(prior);
      if (!object(prior) || prior.operationId !== id || id === operation.operationId || prior.status === 'completed' || prior.unresolved !== undefined) add('OPERATION_TYPE','未解决操作身份、状态或层级无效');
    }
  }
  for (const op of operations) {
    if (!object(op) || !text(op.operationId) || !['pending','partial','unknown','failed','completed'].includes(op.status)) { add('OPERATION_TYPE','操作必须包含身份与明确状态'); continue; }
    if (op.affectedIterationIds !== undefined && (!Array.isArray(op.affectedIterationIds) || !op.affectedIterationIds.every(id=>record(iterations,id)))) add('OPERATION_SCOPE','操作影响范围必须引用已知迭代身份');
    if (op.scopeEvidenceReference !== undefined && (!text(op.scopeEvidenceReference) || !op.affectedIterationIds?.length)) add('OPERATION_SCOPE','补记影响范围须保存依据并明确迭代');
    if (op.resolvedOperationReferences !== undefined && (!object(op.resolvedOperationReferences) || !Object.entries(op.resolvedOperationReferences).every(([id,ref])=>text(id)&&text(ref)))) add('OPERATION_RESOLUTION','操作解决依据引用无效');
  }
  if (state.currentIterationId !== null && (!text(state.currentIterationId) || !record(iterations,state.currentIterationId))) add('ITERATION_POINTER','当前迭代引用无效');
  const known = ['schemaVersion','projectId','revision','currentIterationId','sourceDemands','projectDemands','iterations','prds','prd','lastOperation','lastVerified','software','configurationMaintenance','standards','experience'];
  for (const key of Object.keys(state)) if (!known.includes(key)) add('EXTENSION',`保留未知顶层字段：${key}`,'warning');
  const prdPaths = new Map();
  for (const [id,p] of Object.entries(prds)) {
    if (!object(p) || !text(p.path) || !['碎片','草稿','定稿'].includes(p.lifecycle) || !record(iterations,p.iterationId)) { add('PRD_RECORD',`${id} PRD 记录无效`); continue; }
    if (!Array.isArray(iterations[p.iterationId].prdIds) || !iterations[p.iterationId].prdIds.includes(id)) add('PRD_OWNERSHIP',`${id} 未被所属迭代关联`);
    const normalized = path.normalize(p.path);
    if (prdPaths.has(normalized)) add('PRD_PATH_DUPLICATE',`${id} 与 ${prdPaths.get(normalized)} 指向同一 PRD 路径`);
    else prdPaths.set(normalized,id);
    if (typeof p.effective !== 'boolean') add('PRD_EFFECTIVE_TYPE',`${id} effective 必须是布尔值`);
    if (p.lifecycle === '定稿' && (!text(p.contentDigest) || !/^sha256:[a-f0-9]{64}$/.test(p.contentDigest))) add('PRD_DIGEST',`${id} 定稿缺少有效摘要`);
    if (p.effective && (p.lifecycle !== '定稿' || !text(p.approvalReference) || !text(p.evidence?.remoteCommit) || p.evidence?.remoteDigest !== p.contentDigest || p.evidence?.projectionsVerified !== true || !text(p.evidence?.readBackAt))) add('EFFECTIVE_EVIDENCE',`${id} 声称生效但批准/远端/投影回读证据不完整`);
  }
  for (const [id,it] of Object.entries(iterations)) {
    if (!object(it)) { add('ITERATION_RECORD',`${id} 迭代记录无效`); continue; }
    if (!Array.isArray(it.prdIds) || !it.prdIds.every(text) || new Set(it.prdIds).size !== it.prdIds.length) add('PRD_SET',`${id} PRD 身份集合无效`);
    for (const p of Array.isArray(it.prdIds) ? it.prdIds : []) if (!record(prds,p) || prds[p].iterationId !== id) add('PRD_OWNERSHIP',`${id} PRD 引用不存在或串线`);
    for (const key of ['currentPrdId','draftPrdId']) if (it[key] !== null && (!text(it[key]) || !Array.isArray(it.prdIds) || !it.prdIds.includes(it[key]))) add('PRD_REFERENCE',`${id}.${key} 引用无效`);
    if (it.currentPrdId && lookup(prds,it.currentPrdId)?.lifecycle !== '定稿') add('PRD_CURRENT',`${id} 现行依据不是定稿`);
    if (it.draftPrdId && !['碎片','草稿'].includes(lookup(prds,it.draftPrdId)?.lifecycle)) add('PRD_DRAFT',`${id} 母稿不是碎片/草稿`);
    if (it.baselineIterationId !== null && (!text(it.baselineIterationId) || !record(iterations,it.baselineIterationId) || it.baselineIterationId === id)) add('BASELINE_REFERENCE',`${id} 基线迭代引用无效`);
    if (!['not-started','active','completed'].includes(it.development?.status)) add('DEVELOPMENT_STATUS',`${id} 开发状态无效`);
    if (it.development?.status === 'completed' && (!text(it.completion?.version) || !text(it.completion?.evidence) || !text(it.completion?.userApprovalReference))) add('COMPLETION_EVIDENCE',`${id} 已完成缺少版本、结果或用户批准`);
    const seen = new Set([id]); let parent = it.baselineIterationId;
    while (lookup(iterations,parent)) { if (seen.has(parent)) { add('BASELINE_CYCLE',`${id} 基线关系成环`); break; } seen.add(parent); parent = iterations[parent].baselineIterationId; }
    if (it.scope !== null && it.scope !== undefined && (!object(it.scope) || !Array.isArray(it.scope.demandIds) || !it.scope.demandIds.every(text) || new Set(it.scope.demandIds).size !== it.scope.demandIds.length)) add('SCOPE_TYPE',`${id} 批准集合格式错误`);
  }
  for (const [id,d] of demands) {
    if (!record(iterations,d.iterationId)) add('DEMAND_ITERATION',`${id} 未关联有效迭代`);
    if (d.prdId !== null && (!text(d.prdId) || !record(prds,d.prdId) || prds[d.prdId].iterationId !== d.iterationId)) add('DEMAND_PRD',`${id} PRD 关联无效或串线`);
    if (d.supersededBy !== undefined && (!Array.isArray(d.supersededBy) || !d.supersededBy.every(text))) add('RELATION_TYPE',`${id} 替代关系格式无效`);
  }
  const terminal = (id, visiting = new Set()) => {
    if (!text(id)) { add('SCOPE_IDENTITY','批准范围含无效承接身份'); return []; }
    const d = demands.get(id);
    if (!d) { add('SCOPE_MISSING',`批准范围缺少承接 ${id}`); return []; }
    if (visiting.has(id)) { add('RELATION_CYCLE',`${id} 承接关系成环`); return []; }
    if (!Array.isArray(d.supersededBy) || !d.supersededBy.length) return [id];
    const next = new Set(visiting).add(id);
    return d.supersededBy.flatMap(n => {
      if (demands.get(n)?.iterationId !== d.iterationId) { add('RELATION_CROSS_ITERATION',`${id} 替代承接跨迭代或缺失`); return []; }
      return terminal(n,next);
    });
  };
  for (const id of demands.keys()) terminal(id);
  let projection;
  try { projection = projectProjection(state,project); } catch { /* invalid structures above */ }
  if (projection && ['revision','currentIterationId','prd',...['software','technicalPlan'].filter(k=>Object.hasOwn(state,k))].some(k => !same(project[k],projection[k]))) add('PROJECTION_MISMATCH','项目入口投影与授权底稿不一致',writeAction ? 'blocked' : 'warning');
  if (state.prd !== undefined && projection && !same(state.prd,projection.prd)) add('COMPAT_PROJECTION','底稿兼容 PRD 投影过期',writeAction ? 'blocked' : 'warning');
  if (options.iterationId !== undefined && !record(iterations,options.iterationId)) add('ACTION_ITERATION','检查对象不是有效迭代','blocked');
  if (!writeAction) return outcome();
  const id = options.iterationId;
  const it = lookup(iterations,id);
  if (!text(id) || !record(iterations,id)) { add('ACTION_ITERATION','动作必须明确有效迭代','blocked'); return outcome(); }
  for (const op of operations) if (object(op) && op.status !== 'completed') {
    if (!Array.isArray(op.affectedIterationIds) || !op.affectedIterationIds.length || op.affectedIterationIds.includes(id)) add('OPERATION_PENDING','相关受控操作未完成或结果未知','blocked');
  }
  const p = lookup(prds,action === 'maintain' ? it.maintenance?.prdId : it.currentPrdId);
  if (!p?.effective || p.lifecycle !== '定稿' || p.iterationId !== id) add('PRD_NOT_EFFECTIVE','本动作对应 PRD 尚未生效','blocked');
  if (action === 'maintain') {
    const m = it.maintenance;
    if (it.development?.status !== 'completed') add('MAINTENANCE_BASELINE','旧版维护必须定位已完成版本；进行中的研发修复使用该研发线','blocked');
    if (!text(m?.approvalReference) || m.changesProductFacts !== false || !Array.isArray(m.scopeDemandIds) || !m.scopeDemandIds.length || !m.scopeDemandIds.every(n => demands.get(n)?.iterationId === id)) add('MAINTENANCE_AUTHORITY','旧版维护缺少对应授权/范围或改变产品事实','blocked');
    if (!text(options.version) || options.version !== it.completion?.version) add('MAINTENANCE_VERSION','维护必须明确被修已完成版本','blocked');
    return outcome();
  }
  const scope = it.scope;
  if (!text(scope?.approvalReference) || !Array.isArray(scope?.demandIds) || !scope.demandIds.length) add('SCOPE_UNAPPROVED','批准范围缺失或为空，不可据当前数组反推','blocked');
  else {
    const expected = new Set(scope.demandIds.flatMap(n => terminal(n)));
    const actual = new Set([...demands].filter(([,d]) => d.iterationId === id && !d.supersededBy?.length && d.business?.status !== '已关闭').map(([n]) => n));
    if (!expected.size || [...expected].some(n => demands.get(n)?.iterationId !== id || !actual.has(n)) || [...actual].some(n => !expected.has(n))) add('SCOPE_MISMATCH','批准末端承接与实际活动集合不相等（缺漏、多出或错迭代）','blocked');
    for (const n of actual) if (demands.get(n).prdId !== it.currentPrdId) add('ACTIVE_PRD_MISMATCH','活动承接未对齐本迭代有效 PRD','blocked');
  }
  if (Object.values(iterations).filter(v => v?.development?.status === 'active').length > 1 || Object.entries(iterations).some(([other,v]) => other !== id && v?.development?.status === 'active')) add('DEVELOPMENT_CONCURRENT','已有另一正式研发线','blocked');
  if (it.baselineIterationId && lookup(iterations,it.baselineIterationId)?.development?.status !== 'completed') add('BASELINE_INCOMPLETE','上一版本未完成，允许研讨但不允许新版研发','blocked');
  if (!text(it.development?.approvalReference) || !text(it.development?.technicalPlanApprovalReference)) add('DEVELOPMENT_AUTHORITY','开发许可或技术方案批准缺证','blocked');
  if (action === 'develop' && it.development?.status === 'completed') add('ITERATION_COMPLETED','已完成版本应进入维护或后继迭代','blocked');
  if (action === 'accept' && (!text(it.completion?.userApprovalReference) || !text(it.completion?.evidence) || !text(it.completion?.version))) add('ACCEPTANCE_PENDING','正式验收证据或用户批准缺失','blocked');
  return outcome();

  function outcome() {
    const errors = issues.filter(i => i.level === 'error');
    const blocked = issues.filter(i => i.level === 'blocked');
    const unknown = issues.filter(i => i.level === 'unknown');
    return { valid: !errors.length, action, allowed: !errors.length && !blocked.length && !unknown.length,
      issues, errors: errors.map(i => i.message), blocked, unknown, warnings: issues.filter(i => i.level === 'warning').map(i => i.message) };
  }
}

// Only retired, frozen content can be read from its exact existing Git object.
// Current/draft/maintenance inputs must remain present; never fetch or restore files here.
export async function readPrdFile(root, state, id, p, selected = false) {
  try {
    const file = await boundedPath(root,p.path);
    return { bytes:await readFile(file), file, storage:'workspace' };
  } catch (error) {
    const required = selected || Object.entries(state.iterations ?? {}).some(([iterationId,it]) => object(it) && (
      it.draftPrdId === id || it.maintenance?.prdId === id ||
      (it.currentPrdId === id && (iterationId === state.currentIterationId || it.development?.status !== 'completed'))
    ));
    if (error.code !== 'ENOENT' || required || p.lifecycle !== '定稿' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(p.evidence?.remoteCommit ?? '') || p.evidence?.remoteDigest !== p.contentDigest) throw error;
    const base = await realpath(root), target = path.resolve(base,p.path);
    if (path.isAbsolute(p.path) || p.path.includes('\0') || !target.startsWith(base+path.sep)) throw Object.assign(new Error('历史路径越界'),{code:'PATH_BOUNDARY'});
    // A dangling link is not a retired file; missing ancestors must not conceal an escape.
    try { await lstat(target); throw Object.assign(new Error('历史入口并非已退出的普通文件'),{code:'PATH_BOUNDARY'}); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let parent=path.dirname(target);
    while (true) { try { const actual=await realpath(parent); if (actual!==base && !actual.startsWith(base+path.sep)) throw Object.assign(new Error('历史父路径越界'),{code:'PATH_BOUNDARY'}); break; }
      catch (e) { if(e.code!=='ENOENT') throw e; parent=path.dirname(parent); } }
    try {
      const commit=p.evidence.remoteCommit;
      const prefix=(await gitRead(base,['rev-parse','--show-prefix'])).stdout.toString().replace(/\n$/,'');
      const relative=prefix+path.relative(base,target).split(path.sep).join('/');
      const entry=(await gitRead(base,['--literal-pathspecs','ls-tree','--full-tree','-z',commit,'--',relative])).stdout.toString();
      const match=/^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\0]+)\0$/.exec(entry);
      if (!match || match[3]!==relative) throw Error('not a regular historical blob');
      const bytes=(await gitRead(base,['cat-file','blob',match[2]])).stdout;
      if (digest(bytes)!==p.contentDigest) throw Error('historical digest mismatch');
      return {bytes,storage:'git-history',commit};
    } catch { throw Object.assign(new Error('历史定稿的本地Git对象缺失或摘要不符'),{code:'PRD_HISTORY_UNAVAILABLE'}); }
  }
}

export async function loadProject(root, options = {}) {
  const io = [];
  async function read(relative) {
    try {
      const file = await boundedPath(root,relative);
      const raw = await readFile(file,'utf8');
      const parsed = parse(raw,relative); io.push(...parsed.issues);
      return { ...parsed, raw, digest: digest(raw), path: relative };
    } catch (e) { io.push(issue(e.code === 'PATH_BOUNDARY' ? e.code : 'FILE_UNREADABLE',`${relative} 无法安全读取`)); return { value: null, digest: null, path: relative }; }
  }
  const stateFile = await read('.steven/state/authorized.json');
  const projectFile = await read('.steven/project.json');
  const state = stateFile.value, project = projectFile.value;
  const result = validateState(state,project,options);
  const records = [];
  const selectedIteration = state?.schemaVersion === '3' ? lookup(state.iterations,options.iterationId) : undefined;
  const selectedIds = selectedIteration ? new Set(
    options.action === 'maintain' ? [selectedIteration.maintenance?.prdId] :
    ['develop','accept'].includes(options.action) ? [selectedIteration.currentPrdId] :
    [selectedIteration.currentPrdId,selectedIteration.draftPrdId]
  ) : null;
  if (state?.schemaVersion === '3' && object(state.prds)) {
    for (const [id,p] of Object.entries(state.prds)) if (object(p) && (!selectedIds || selectedIds.has(id))) records.push({ ...p, id });
  } else if (state?.schemaVersion === '2') {
    for (const [label,v] of [['底稿',state],['入口',project]]) for (const key of ['current','draft']) if (v?.prd?.[key]) records.push({ id: `${label}:${key}`, path: v.prd[key], contentDigest: key === 'current' ? v.prd.contentDigest : null });
  }
  const files = [], resolvedPrds = new Map();
  for (const p of records) {
    const label = text(p.path) ? p.path : `PRD ${p.id} 的路径字段`;
    try {
      const loaded = state?.schemaVersion === '3' ? await readPrdFile(root,state,p.id,p,selectedIds?.has(p.id)) : {file:await boundedPath(root,p.path)};
      if (loaded.file && state?.schemaVersion === '3' && resolvedPrds.has(loaded.file)) io.push(issue('PRD_PATH_DUPLICATE',`${label} 与 ${resolvedPrds.get(loaded.file)} 实际指向同一 PRD`));
      else if (loaded.file) resolvedPrds.set(loaded.file,p.id);
      const bytes = loaded.bytes ?? await readFile(loaded.file); const actualDigest = digest(bytes);
      files.push({ id:p.id,path:p.path,digest:actualDigest,...(loaded.storage==='git-history'?{storage:loaded.storage,commit:loaded.commit}:{}) });
      if (p.contentDigest && p.contentDigest !== actualDigest) io.push(issue('PRD_DIGEST_MISMATCH',`${label} PRD 摘要与正文不一致`));
    } catch (e) { io.push(issue(['PATH_BOUNDARY','PRD_HISTORY_UNAVAILABLE'].includes(e.code) ? e.code : 'PRD_UNREADABLE',`${label} PRD 文件或指定历史无法安全读取`)); }
  }
  result.issues.push(...io); result.errors.push(...io.map(i=>i.message));
  result.valid &&= !io.length; result.allowed &&= !io.length;
  return { ...result, state, project, files, fileScope:selectedIds?{kind:'task',iterationId:options.iterationId,prdIds:records.map(p=>p.id)}:{kind:'project'}, stateDigest:stateFile.digest, projectDigest:projectFile.digest };
}
