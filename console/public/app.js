/* 定位控制台 — 前端逻辑（原生 JS，零依赖）
 * 测试用例格式：标题 + 步骤（按需添加）+ 每步骤可选 xpath
 * 动作语义完全覆盖 Midscene Web Agent：操作(11) / 任务(1) / 检查(7)
 */
const $ = (sel) => document.querySelector(sel);

const OP = 'op', TASK = 'task', CHECK = 'check';
const ACTIONS = {
  tap:          { group: OP,    label: '点击',     node: 'aiTap',           xpath: true,  promptOptional: false },
  doubleClick:  { group: OP,    label: '双击',     node: 'aiDoubleClick',   xpath: true,  promptOptional: false },
  middleClick:  { group: OP,    label: '中键点击', node: 'aiMiddleClick',   xpath: true,  promptOptional: false },
  rightClick:   { group: OP,    label: '右击',     node: 'aiRightClick',    xpath: true,  promptOptional: false },
  hover:        { group: OP,    label: '悬停',     node: 'aiHover',         xpath: true,  promptOptional: false },
  longPress:    { group: OP,    label: '长按',     node: 'aiLongPress',     xpath: true,  promptOptional: false },
  input:        { group: OP,    label: '输入',     node: 'aiInput',         xpath: true,  promptOptional: false,
                  value: { label: '输入内容', placeholder: '要输入的文本', required: true } },
  clearInput:   { group: OP,    label: '清空输入', node: 'aiClearInput',    xpath: true,  promptOptional: false },
  keyboardPress:{ group: OP,    label: '按键',     node: 'aiKeyboardPress', xpath: true,  promptOptional: true,
                  value: { label: '按键名', placeholder: 'Enter', required: true } },
  scroll:       { group: OP,    label: '滚动',     node: 'aiScroll',        xpath: true,  promptOptional: true,
                  value: { label: '方向 [距离]', placeholder: 'down 或 down 600', required: true } },
  locate:       { group: OP,    label: '仅定位',   node: 'aiLocate',        xpath: true,  promptOptional: false },
  act:          { group: TASK,  label: '执行任务', node: 'aiAct',           xpath: false, promptOptional: false },
  assert:       { group: CHECK, label: '断言',     node: 'aiAssert',        xpath: false, promptOptional: false },
  waitFor:      { group: CHECK, label: '等待条件', node: 'aiWaitFor',       xpath: false, promptOptional: false },
  boolean:      { group: CHECK, label: '布尔判断', node: 'aiBoolean',       xpath: false, promptOptional: false },
  query:        { group: CHECK, label: '提取数据', node: 'aiQuery',         xpath: false, promptOptional: false },
  number:       { group: CHECK, label: '数字提取', node: 'aiNumber',        xpath: false, promptOptional: false },
  string:       { group: CHECK, label: '文本提取', node: 'aiString',        xpath: false, promptOptional: false },
  ask:          { group: CHECK, label: '提问',     node: 'aiAsk',           xpath: false, promptOptional: false },
};
const GROUP_LABEL = { [OP]: '操作（可附 xpath）', [TASK]: '任务', [CHECK]: '检查（无 xpath）' };

const TIER_BADGE = {
  '1-explicit': { cls: 't1', label: 'Tier 1 · 显式 xpath' },
  '2-cache':    { cls: 't2', label: 'Tier 2 · 缓存命中' },
  '3-ai':       { cls: 't3', label: 'Tier 3 · AI 视觉' },
  'ai-semantic':{ cls: 't3', label: 'AI 语义' },
};

const LS_KEY = 'locate-console-case-v2'; // 仅用于启动时清理历史残留，编辑状态不再持久化
let uid = Date.now();
const newId = () => `s${++uid}`;

let caseData = { title: '', steps: [], params: [] };
let busy = false;

// ---------------------------------------------------------------- 业务语义 + 参数驱动（语法对齐 Midscene 官方）
// #region param-logic
const SEMANTIC_PREFIX = 'sem:';
let semantics = []; // [{name, steps:[{action,prompt,xpath,value}], paramNames:[...]}]
// 官方语法：${name} 读项目 variables；${{ENV_NAME}} 读环境变量（保留给 Midscene runner 解析）
const ENV_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;
// 同时兼容旧的 {{name}} 双花括号写法
const PARAM_RE = /\$\{\s*([^}${]+?)\s*\}|\{\{\s*([^}${]+?)\s*\}\}/g;
const paramKeyOf = (a, b) => String(a ?? b ?? '').trim();

function extractParams(steps) {
  const set = new Set();
  for (const s of steps) for (const f of [s.prompt, s.xpath, s.value]) {
    const text = String(f ?? '').replace(ENV_RE, ''); // 环境变量不计入用例参数
    text.replace(PARAM_RE, (_, a, b) => { const k = paramKeyOf(a, b); if (k) set.add(k); return ''; });
  }
  return [...set];
}

async function loadSemantics() {
  try {
    const r = await api('/api/semantics');
    semantics = (r.semantics || []).map((s) => ({ ...s, paramNames: extractParams(s.steps) }));
  } catch { semantics = []; }
}
function semanticByName(name) { return semantics.find((s) => s.name === name); }
function isSemStep(s) { return String(s.action).startsWith(SEMANTIC_PREFIX); }

// ${name} → 取值；${{ENV}} 原样保留（官方环境变量，交给 Midscene runner 解析）
function subst(str, ...sources) {
  let text = String(str ?? '');
  const envHolds = [];
  text = text.replace(ENV_RE, (m) => { envHolds.push(m); return '@@ENV' + (envHolds.length - 1) + '@@'; });
  text = text.replace(PARAM_RE, (_, a, b) => {
    const key = paramKeyOf(a, b);
    for (const src of sources) {
      if (!src) continue;
      const val = src[key];
      if (val === undefined) continue;
      if (Array.isArray(val)) { if (!val.length) continue; return String(val[0]); }
      if (String(val) !== '') return String(val);
    }
    return '$' + '{' + key + '}'; // 未赋值时保留官方变量语法
  });
  return text.replace(/@@ENV(\d+)@@/g, (_, i) => envHolds[Number(i)]);
}



// 列出仍未被赋值的参数名（${{ENV}} 是官方环境变量，不算未赋值）
function unresolvedParams(text) {
  const clean = String(text ?? '').replace(ENV_RE, '');
  return [...clean.matchAll(PARAM_RE)].map((m) => paramKeyOf(m[1], m[2])).filter(Boolean);
}
function parseKv(text) {
  const o = {};
  String(text ?? '').split(/[,，;；]/).forEach((pair) => {
    const m = pair.match(/^\s*([^=:：|]+)[:=：]\s*(.*)$/);
    if (m && m[1].trim()) {
      const k = m[1].trim();
      const v = m[2].trim();
      if (o[k] === undefined) { o[k] = v.includes('|') ? v.split('|').map((x) => x.trim()) : v; }
      else {
        const arr = Array.isArray(o[k]) ? o[k] : [o[k]];
        arr.push(v);
        o[k] = arr;
      }
    }
  });
  return o;
}

// 展开：返回「轮」数组——每个语义的列表参数产生一轮（每轮独立定位上下文，执行前重建 Agent）；
// 普通步骤并入当前轮。调用参数优先于用例参数。
function expandSteps(steps, caseParams) {
  const rounds = [[]];
  for (const s of steps) {
    if (isSemStep(s)) {
      const name = s.action.slice(SEMANTIC_PREFIX.length);
      const sem = semanticByName(name);
      if (!sem) throw new Error(`业务语义未找到：${name}（可能已被删除）`);
      const callParams = parseKv(s.value);
      const listKeys = Object.keys(callParams).filter((k) => Array.isArray(callParams[k]));
      if (listKeys.length) {
        const len = callParams[listKeys[0]].length;
        for (const k of listKeys) {
          if (callParams[k].length !== len) {
            throw new Error(`语义「${name}」多值参数长度不一致：${listKeys.map((x) => `${x}(${callParams[x].length})`).join(', ')}——请保持各列表参数值数量相同`);
          }
        }
        for (let r = 0; r < len; r++) {
          const rp = { ...callParams };
          for (const k of listKeys) rp[k] = callParams[k][r];
          rounds.push(sem.steps.map((sub) => ({
            action: sub.action,
            prompt: subst(sub.prompt, rp, caseParams),
            xpath: subst(sub.xpath, rp, caseParams),
            value: subst(sub.value, rp, caseParams),
          })));
        }
      } else {
        for (const sub of sem.steps) {
          rounds[rounds.length - 1].push({
            action: sub.action,
            prompt: subst(sub.prompt, callParams, caseParams),
            xpath: subst(sub.xpath, callParams, caseParams),
            value: subst(sub.value, callParams, caseParams),
          });
        }
      }
    } else {
      rounds[rounds.length - 1].push({
        action: s.action,
        prompt: subst(s.prompt, caseParams),
        xpath: subst(s.xpath, caseParams),
        value: subst(s.value, caseParams),
      });
    }
  }
  return rounds.filter((r) => r.length);
}
function flattenRounds(rounds) { return rounds.flat(); }

// 参数表 → 多轮：列表值（a=1|2 或重复键 a=1,a=2）每个值一轮，返回标量参数对象数组
function expandParamRounds(params) {
  const listKeys = Object.keys(params || {}).filter((k) => Array.isArray(params[k]));
  if (!listKeys.length) return [params || {}];
  const len = params[listKeys[0]].length;
  for (const k of listKeys) {
    if (params[k].length !== len) {
      throw new Error(`多值参数数量不一致：${listKeys.map((x) => `${x}(${params[x].length} 个值)`).join(', ')}——请保持相同数量的值`);
    }
  }
  return Array.from({ length: len }, (_, r) => {
    const one = { ...params };
    for (const k of listKeys) one[k] = params[k][r];
    return one;
  });
}

/**
 * 参数表 → 参数对象：`a=1|2` 拆成数组；同名重复行按「重复键写法」追加合并（不再后行覆盖前行）；
 * 空值不参与合并，保留“未赋值”语义（步骤里的占位符会原样保留，保存/执行时被拦截）。
 */
function caseParamsObj() {
  const o = {};
  for (const p of (caseData.params || [])) {
    const k = String(p?.k ?? '').trim();
    if (!k) continue;
    const raw = String(p?.v ?? '');
    const values = raw.includes('|') ? raw.split('|').map((x) => x.trim()) : [raw.trim()];
    const prev = k in o ? (Array.isArray(o[k]) ? o[k] : [o[k]]) : [];
    const merged = [...prev, ...values].filter((x) => x !== '');
    o[k] = merged.length === 0 ? '' : (merged.length === 1 ? merged[0] : merged);
  }
  return o;
}

// 步骤里真正被引用的 ${参数名}（含语义模板形参与语义调用参数；${{ENV}} 环境变量不计入）
function referencedParamKeys(steps) {
  const keys = new Set();
  const collect = (fields) => {
    for (const f of fields) for (const k of unresolvedParams(f)) keys.add(k);
  };
  for (const s of steps) {
    collect([s.prompt, s.xpath, s.value]);
    if (isSemStep(s)) {
      const sem = semanticByName(s.action.slice(SEMANTIC_PREFIX.length));
      if (sem) for (const sub of sem.steps) collect([sub.prompt, sub.xpath, sub.value]);
    }
  }
  return keys;
}

// 只把「被步骤引用」的参数送进轮次：保存后回读的用例已是字面值，侧车参数不应再制造重复轮次
function effectiveCaseParams(steps) {
  const referenced = referencedParamKeys(steps);
  const all = caseParamsObj();
  const effective = {};
  for (const k of Object.keys(all)) {
    if (referenced.has(k)) effective[k] = all[k];
  }
  return effective;
}

// 用例级展开（运行 / 保存 / 单步 ▶ 共用）：多值参数逐值一轮 + 语义调用参数轮次
function expandCaseRounds(steps) {
  return expandParamRounds(effectiveCaseParams(steps)).flatMap((p) => expandSteps(steps, p));
}
// #endregion param-logic

function defaultStep(action = 'tap') {
  return { id: newId(), action, prompt: '', xpath: '', value: '' };
}

function loadCase() {
  // 每次打开前端均为全新编辑状态（不保留上次步骤记录）。
  // 已保存的用例走右侧用例库（落盘 YAML），与此编辑区无关。
  localStorage.removeItem(LS_KEY);
  caseData = { title: '', steps: [defaultStep()], params: [] };
  currentFile = null;
  currentGroup = '';
}

function saveCaseLocal() {
  // 编辑状态不持久化（空实现，兼容既有调用点）
}

// ---------------------------------------------------------------- rendering
function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function actionOptions(selected) {
  const groups = { [OP]: [], [TASK]: [], [CHECK]: [] };
  for (const [key, cfg] of Object.entries(ACTIONS)) groups[cfg.group].push([key, cfg]);
  let html = Object.entries(groups).filter(([, items]) => items.length).map(([g, items]) =>
    `<optgroup label="${esc(GROUP_LABEL[g])}">` +
    items.map(([key, cfg]) =>
      `<option value="${key}"${key === selected ? ' selected' : ''}>${esc(cfg.label)}</option>`).join('') +
    '</optgroup>'
  ).join('');
  // 动态分组：已保存的业务语义
  if (semantics.length) {
    html += `<optgroup label="业务语义（组合步骤）">` +
      semantics.map((s) => {
        const key = SEMANTIC_PREFIX + s.name;
        return `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>⚡ ${esc(s.name)}（${s.steps.length} 步）</option>`;
      }).join('') + '</optgroup>';
  }
  return html;
}

function renderSteps() {
  const box = $('#steps');
  box.innerHTML = caseData.steps.map((s, idx) => {
    if (isSemStep(s)) {
      const name = s.action.slice(SEMANTIC_PREFIX.length);
      const sem = semanticByName(name);
      const semParams = sem ? extractParams(sem.steps) : [];
      const semMeta = sem ? `⚡ ${esc(name)} · ${sem.steps.length} 步` : `⚡ ${esc(name)} · <span class="err-text">未找到（已被删除）</span>`;
      return `
      <div class="step sem-step" data-id="${s.id}">
        <span class="step-no">${idx + 1}</span>
        <select class="s-action" title="动作">${actionOptions(s.action)}</select>
        <span class="sem-ref" title="组合步骤：运行时自动展开为原子步骤">${semMeta}</span>
        <input class="s-value" type="text" spellcheck="false" placeholder="${semParams.length ? '参数: ' + esc(semParams.map((p) => p + '=…').join(', ')) : '（该语义无参数）'}" value="${esc(s.value)}" ${semParams.length ? '' : 'hidden'} title="语义调用参数，格式 a=1, b=2">
        <button class="s-run icon" title="仅运行此语义">▶</button>
        <button class="s-up icon" title="上移">↑</button>
        <button class="s-down icon" title="下移">↓</button>
        <button class="s-del icon" title="删除">✕</button>
      </div>`;
    }
    const cfg = ACTIONS[s.action];
    const showValue = !!cfg.value;
    const showXpath = !!cfg.xpath;
    const promptPh = cfg.promptOptional ? '目标元素（可留空 = 整页动作）· 支持 ${参数名}' : '自然语言描述目标 · 支持 ${参数名}';
    return `
    <div class="step" data-id="${s.id}">
      <span class="step-no">${idx + 1}</span>
      <select class="s-action" title="动作">${actionOptions(s.action)}</select>
      <input class="s-prompt" type="text" spellcheck="false" placeholder="${promptPh}" value="${esc(s.prompt)}">
      <input class="s-value" type="text" spellcheck="false" placeholder="${cfg.value ? cfg.value.placeholder : ''}" value="${esc(s.value)}" ${showValue ? '' : 'hidden'}>
      <input class="s-xpath" type="text" spellcheck="false" placeholder="可选 xpath" value="${esc(s.xpath)}" ${showXpath ? '' : 'hidden'} title="留空 = 三层链路自动解析 · 支持 \${参数名}">
      <button class="s-run icon" title="仅运行此步骤">▶</button>
      <button class="s-up icon" title="上移">↑</button>
      <button class="s-down icon" title="下移">↓</button>
      <button class="s-del icon" title="删除">✕</button>
    </div>`;
  }).join('');
}

function renderResultValue(result) {
  if (result === undefined || result === null) return '';
  const text = typeof result === 'object' ? JSON.stringify(result) : String(result);
  return `<div class="result-line">结果：${esc(text.length > 300 ? text.slice(0, 300) + '…' : text)}</div>`;
}

function addCard(card) {
  const feed = $('#feed');
  feed.querySelector('.empty')?.remove();
  const badge = TIER_BADGE[card.tier] || { cls: 't3', label: card.tier || '—' };
  const el = document.createElement('div');
  el.className = `card ${card.error ? 'err' : badge.cls}`;
  el.innerHTML = `
    <div class="card-top">
      ${card.stepNo ? `<span class="step-no small">${card.stepNo}</span>` : ''}
      <span class="badge ${card.error ? 'err' : badge.cls}">${esc(card.error ? '失败' : badge.label)}</span>
      <span class="ms">${esc(card.actionLabel || card.action || '')}${card.ms ? ` · ${card.ms} ms` : ''}</span>
    </div>
    <div class="prompt-line">${card.prompt ? `“${esc(card.prompt)}”` : ''}</div>
    ${card.note ? `<div class="note">${esc(card.note)}</div>` : ''}
    ${card.error ? `<div class="note err">✕ ${esc(card.error)}</div>` : ''}
    ${renderResultValue(card.result)}
    ${card.xpath ? `<div class="xpath-chip" title="点击复制">xpath: ${esc(card.xpath)}</div>` : ''}
  `;
  el.querySelector('.xpath-chip')?.addEventListener('click', (e) => {
    navigator.clipboard?.writeText(e.target.textContent.replace(/^xpath:\s*/, ''));
  });
  feed.prepend(el);
}

function addNoteCard(text) {
  const feed = $('#feed');
  feed.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = 'card save';
  el.innerHTML = `<div class="note">${esc(text)}</div>`;
  feed.prepend(el);
}

// 每次新的执行（运行用例 / 批量回归 / 单步）开始时清空结果栏，只显示本次记录
function resetFeed() {
  $('#feed').innerHTML = '';
}

// ---------------------------------------------------------------- api
async function api(path, body) {
  const res = await fetch(path, body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  } : undefined);
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// 重建服务端 Agent（每轮语义/用例执行前调用：干净定位上下文，缓存仍从文件命中）
async function resetAgentSession() {
  try { await api('/api/agent/reset', {}); } catch { /* best-effort */ }
}
function setShot(dataUrl) {
  if (!dataUrl) return;
  $('#shot').src = dataUrl;
  $('#shot-hint').hidden = true;
}

async function refreshState() {
  try {
    const s = await api('/api/state');
    $('#url').value = s.url || '';
    $('#model-tag').textContent = s.model ? ` · 模型 ${s.model}` : '';
    if (s.screenshot) setShot(s.screenshot);
  } catch (err) {
    $('#shot-hint').textContent = `状态获取失败：${err.message}`;
  }
}

// ---------------------------------------------------------------- 已保存用例（分组 + 批量回归）
const selectedFiles = new Set();
let currentFile = null; // 正在编辑的用例文件（cases/...）；null = 新用例
let currentGroup = '';  // 正在编辑的用例分组
// 分组折叠状态（持久化；'' = 默认组）
const LS_COLLAPSED = 'locate-console-collapsed';
let collapsedGroups = new Set(JSON.parse(localStorage.getItem(LS_COLLAPSED) || '[]'));
function saveCollapsed() {
  localStorage.setItem(LS_COLLAPSED, JSON.stringify([...collapsedGroups]));
}

async function loadCases() {
  const box = $('#case-groups');
  try {
    const data = await api('/api/cases');
    renderCaseGroups(data.groups || []);
  } catch (err) {
    box.innerHTML = `<p class="empty">加载失败：${esc(err.message)}</p>`;
  }
}

function renderCaseGroups(groups) {
  const box = $('#case-groups');
  if (!groups.length) {
    box.innerHTML = '<p class="empty">尚无用例 —— 左侧编辑后点「保存」</p>';
    updateSelInfo();
    return;
  }
  box.innerHTML = groups.map((g) => {
    const groupLabel = g.group ? esc(g.group) : '默认（cases/ 根目录）';
    const isCollapsed = collapsedGroups.has(g.group);
    const items = g.files.map((f) => {
      const checked = selectedFiles.has(f.file) ? ' checked' : '';
      const cases = f.cases.map((c) =>
        `<div class="ci-case"><span class="ci-name">${esc(c.name)}</span><span class="ci-meta">${c.steps} 步 · ${esc(c.actions.join('/'))}</span></div>`
      ).join('');
      return `
      <div class="case-item" data-file="${esc(f.file)}">
        <label class="ci-check"><input type="checkbox" class="ci-cb"${checked}></label>
        <div class="ci-body">${cases}</div>
        <div class="ci-ops">
          <button class="ci-edit icon" title="加载到编辑器（可改参数后重新保存）">✎</button>
          <button class="ci-run icon" title="回归此文件">▶</button>
          <button class="ci-del icon" title="删除">✕</button>
        </div>
      </div>`;
    }).join('');
    return `
    <div class="case-group${isCollapsed ? ' collapsed' : ''}" data-group="${esc(g.group)}">
      <div class="group-head" title="点击折叠/展开">
        <span class="group-toggle">${isCollapsed ? '▸' : '▾'}</span>
        <span class="group-name">${groupLabel}</span>
        <span class="group-count">${g.files.length}</span>
        <label class="group-sel"><input type="checkbox" class="g-sel"> 选组</label>
      </div>
      ${items}
    </div>`;
  }).join('');
  updateSelInfo();
}

function updateSelInfo() {
  $('#sel-info').textContent = selectedFiles.size ? `已选 ${selectedFiles.size} 个文件` : '未选择';
  const btn = $('#btn-run-selected');
  btn.disabled = !selectedFiles.size;
  btn.title = selectedFiles.size
    ? `回归运行选中的 ${selectedFiles.size} 个用例文件`
    : '请先在下方勾选要回归的用例';
  const items = [...document.querySelectorAll('.case-item')];
  $('#sel-all').checked = items.length > 0 && items.every((item) => selectedFiles.has(item.dataset.file));
}

$('#case-groups').addEventListener('change', (e) => {
  if (e.target.classList.contains('g-sel')) {
    const group = e.target.closest('.case-group');
    const files = [...group.querySelectorAll('.case-item')].map((item) => item.dataset.file);
    files.forEach((f) => (e.target.checked ? selectedFiles.add(f) : selectedFiles.delete(f)));
    group.querySelectorAll('.ci-cb').forEach((cb) => { cb.checked = e.target.checked; });
    updateSelInfo();
    return;
  }
  if (e.target.classList.contains('ci-cb')) {
    const file = e.target.closest('.case-item').dataset.file;
    if (e.target.checked) selectedFiles.add(file); else selectedFiles.delete(file);
    updateSelInfo();
  }
});

// 「全选」在 .run-bar 里，不在 #case-groups 内，必须独立绑定
$('#sel-all').addEventListener('change', (e) => {
  const all = e.target.checked;
  document.querySelectorAll('.case-item').forEach((item) => {
    const file = item.dataset.file;
    if (all) selectedFiles.add(file); else selectedFiles.delete(file);
    item.querySelector('.ci-cb').checked = all;
  });
  updateSelInfo();
});

$('#case-groups').addEventListener('click', async (e) => {
  // 组头折叠/展开（checkbox「选组」区域除外）
  const head = e.target.closest('.group-head');
  if (head && !e.target.closest('.group-sel')) {
    const group = head.closest('.case-group');
    const name = group.dataset.group;
    const nowCollapsed = !collapsedGroups.has(name);
    if (nowCollapsed) collapsedGroups.add(name); else collapsedGroups.delete(name);
    saveCollapsed();
    group.classList.toggle('collapsed', nowCollapsed);
    head.querySelector('.group-toggle').textContent = nowCollapsed ? '▸' : '▾';
    return;
  }
  const item = e.target.closest('.case-item');
  if (!item || busy) return;
  const file = item.dataset.file;
  if (e.target.classList.contains('ci-edit')) {
    await loadCaseFromFile(file);
  } else if (e.target.classList.contains('ci-run')) {
    await runRegression([file]);
  } else if (e.target.classList.contains('ci-del')) {
    if (!confirm(`删除用例文件 ${file}？`)) return;
    try {
      await api('/api/case/delete', { file });
      selectedFiles.delete(file);
      loadCases();
    } catch (err) { alert(`删除失败：${err.message}`); }
  }
});

function renderRegressionResult(r) {
  const feed = $('#feed');
  feed.querySelector('.empty')?.remove();
  const el = document.createElement('div');
  el.className = `card ${r.passed ? 't1' : 'err'}`;
  const stepLines = (r.steps || []).map((s) => {
    const badge = TIER_BADGE[s.tier] || { cls: 't3', label: s.tier || '—' };
    return s.ok
      ? `<div class="rs-line"><span class="badge ${badge.cls}">${esc(badge.label)}</span> 步骤${s.no} ${esc(s.action)} · ${s.ms} ms${s.xpath ? ` · <code>${esc(s.xpath)}</code>` : ''}${renderResultValue(s.result)}</div>`
      : `<div class="rs-line fail">✕ 步骤${s.no} ${esc(s.action)} · ${esc(s.error || '')}</div>`;
  }).join('');
  el.innerHTML = `
    <div class="card-top">
      <span class="badge ${r.passed ? 't1' : 'err'}">${r.passed ? '✓ 通过' : '✕ 失败'}</span>
      <span class="ms">${esc(r.name)} · ${r.executed ?? (r.steps || []).length}/${r.total ?? '?'} 步 · ${r.ms || 0} ms</span>
    </div>
    ${r.error ? `<div class="note err">✕ ${esc(r.error)}</div>` : ''}
    ${stepLines}
  `;
  feed.prepend(el);
}

async function runRegression(files) {
  setBusy(true);
  resetFeed();
  addNoteCard(`▶ 开始回归 ${files.length} 个文件…`);
  try {
    const r = await api('/api/case/run', { files });
    [...r.results].reverse().forEach((x) => renderRegressionResult(x));
    addNoteCard(`回归完成：${r.passedCount}/${r.total} 通过`);
    if (r.results?.length && r.results[r.results.length - 1]?.screenshot) {
      setShot(r.results[r.results.length - 1].screenshot);
    }
  } catch (err) {
    addNoteCard(`✕ 回归失败：${err.message}`);
  } finally {
    setBusy(false);
    refreshState();
  }
}

$('#btn-run-selected').addEventListener('click', () => {
  if (selectedFiles.size) runRegression([...selectedFiles]);
});
$('#btn-cases-refresh').addEventListener('click', loadCases);

// ---------------------------------------------------------------- 业务语义面板 + 存为语义
function renderSemantics() {
  const box = $('#sem-list');
  if (!semantics.length) {
    box.innerHTML = '<p class="empty">尚无语义 —— 左侧编辑步骤后点「⚡ 存为语义」</p>';
    return;
  }
  box.innerHTML = semantics.map((s) => `
    <div class="sem-item" data-name="${esc(s.name)}">
      <div class="sem-info">
        <div class="sem-name">⚡ ${esc(s.name)}</div>
        <div class="sem-meta">${s.steps.length} 步${s.paramNames.length ? ` · 参数: ${esc(s.paramNames.join(', '))}` : ' · 无参数'}</div>
      </div>
      <div class="sem-ops">
        <button class="sem-edit icon" title="加载到编辑器（可改步骤/参数后重新保存）">✎</button>
        <button class="sem-run icon" title="直接运行此语义">▶</button>
        <button class="sem-del icon" title="删除">✕</button>
      </div>
    </div>`).join('');
}

async function loadCaseFromFile(file) {
  try {
    const r = await api('/api/case/load', { file });
    caseData = {
      title: r.title || '',
      steps: (r.steps || []).map((s) => ({ id: newId(), action: s.action, prompt: String(s.prompt ?? ''), xpath: String(s.xpath ?? ''), value: String(s.value ?? '') })),
      params: (r.params || []).map((p) => ({ k: String(p.k ?? ''), v: String(p.v ?? '') })),
    };
    currentFile = file;
    currentGroup = file.split('/')[1] ?? '';
    $('#case-title').value = caseData.title;
    $('#case-group').value = currentGroup;
    renderSteps();
    renderParams();
    addNoteCard(`✎ 已加载用例到编辑器：${r.title || file}（${caseData.steps.length} 步${caseData.params.length ? ` · ${caseData.params.length} 个参数` : ''}）—— 改完点「保存」覆盖原文件`);
  } catch (err) {
    addNoteCard(`✕ 加载失败：${err.message}`);
  }
}

function loadSemanticToEditor(name) {
  const sem = semanticByName(name);
  if (!sem) { addNoteCard(`✕ 语义未找到：${name}`); return; }
  caseData = {
    title: sem.name,
    steps: sem.steps.map((s) => ({ id: newId(), action: s.action, prompt: String(s.prompt ?? ''), xpath: String(s.xpath ?? ''), value: String(s.value ?? '') })),
    params: sem.paramNames.map((n) => ({ k: n, v: '' })), // 形参行：调用处填值
  };
  currentFile = null; // 语义覆盖走「⚡ 存为语义」同名保存
  currentGroup = '';
  $('#case-title').value = caseData.title;
  $('#case-group').value = '';
  renderSteps();
  renderParams();
  addNoteCard(`✎ 已加载语义「${name}」到编辑器（${sem.steps.length} 步）—— 改完点「⚡ 存为语义」同名覆盖`);
}

async function runSemanticNow(name) {
  const sem = semanticByName(name);
  if (!sem) { addNoteCard(`✕ 语义未找到：${name}`); return; }
  const paramNames = sem.paramNames || [];
  let callParams = {};
  if (paramNames.length) {
    const input = prompt(
      `语义「${name}」需要参数：${paramNames.join(', ')}\n多值用 | 分隔 → 数据驱动，每个值执行一轮（如 name=1|2 → 2 轮）`,
      paramNames.map((n) => `${n}=`).join(', '),
    );
    if (input === null) return; // 用户取消
    callParams = parseKv(input);
  }
  // 形参多值 → 每值一轮（动作不变，只替换取值）
  let rounds;
  try {
    rounds = expandParamRounds(callParams).map((p) =>
      sem.steps.map((st) => ({
        action: st.action,
        prompt: subst(st.prompt, p),
        xpath: subst(st.xpath, p),
        value: subst(st.value, p),
      })),
    );
  } catch (err) {
    addNoteCard(`✕ ${err.message}`);
    return;
  }
  setBusy(true);
  resetFeed();
  try {
    const total = rounds.reduce((n, r) => n + r.length, 0);
    addNoteCard(`▶ 运行语义「${name}」：${rounds.length} 轮 / 共 ${total} 个原子步骤`);
    let no = 0;
    for (let r = 0; r < rounds.length; r++) {
      if (rounds.length > 1) addNoteCard(`— 第 ${r + 1}/${rounds.length} 轮 —`);
      await resetAgentSession();
      for (const step of rounds[r]) {
        no += 1;
        const ok = await runOne(step, no);
        if (!ok) { addNoteCard(`步骤 ${no} 失败，已停止（bail）`); return; }
      }
    }
    addNoteCard(`✓ 语义「${name}」执行完成（${no} 步 / ${rounds.length} 轮）`);
  } catch (err) {
    addNoteCard(`✕ ${err.message}`);
  } finally {
    setBusy(false);
    refreshState();
  }
}

$('#sem-list').addEventListener('click', async (e) => {
  const item = e.target.closest('.sem-item');
  if (!item || busy) return;
  const name = item.dataset.name;
  if (e.target.classList.contains('sem-edit')) {
    loadSemanticToEditor(name);
  } else if (e.target.classList.contains('sem-run')) {
    await runSemanticNow(name);
  } else if (e.target.classList.contains('sem-del')) {
    if (!confirm(`删除业务语义「${name}」？（已保存的用例不受影响）`)) return;
    try {
      await api('/api/semantic/delete', { name });
      await loadSemantics();
      renderSemantics();
      renderSteps(); // 动作下拉同步
    } catch (err) { alert(`删除失败：${err.message}`); }
  }
});
$('#btn-sem-refresh').addEventListener('click', async () => {
  await loadSemantics();
  renderSemantics();
  renderSteps();
});

$('#btn-save-semantic').addEventListener('click', async () => {
  if (busy) return;
  const valid = caseData.steps.filter(isValidStep);
  if (!valid.length) { alert('请先添加至少一个有效步骤'); return; }
  if (valid.some(isSemStep)) { alert('语义不支持嵌套引用其他语义——请先移除语义步骤'); return; }
  const name = (prompt('业务语义名称（保存后在动作下拉「业务语义」分组中调用）：', caseData.title.trim() || '') || '').trim();
  if (!name) return;
  try {
    await api('/api/semantic/save', {
      name,
      steps: valid.map((s) => ({
        action: s.action,
        prompt: s.prompt, // 原样保留 ${参数名} 作为语义形参（保存时不固化，调用时传值）
        xpath: s.xpath,
        value: s.value,
      })),
    });
    await loadSemantics();
    renderSemantics();
    renderSteps();
    addNoteCard(`✓ 语义「${name}」已保存 —— 新步骤的动作下拉选 ⚡ ${name} 即可调用`);
  } catch (err) {
    addNoteCard(`✕ 语义保存失败：${err.message}`);
  }
});

// ---------------------------------------------------------------- 用例参数面板（${参数名} 取值）
function renderParams() {
  const box = $('#param-rows');
  box.innerHTML = (caseData.params || []).map((p, i) => `
    <div class="param-row" data-i="${i}">
      <input class="p-k" type="text" spellcheck="false" placeholder="参数名" value="${esc(p.k)}">
      <span class="p-eq">=</span>
      <input class="p-v" type="text" spellcheck="false" placeholder="取值（多值用 | 分隔 → 多轮）" value="${esc(p.v)}">
      <button class="p-del icon" title="删除参数">✕</button>
    </div>`).join('') || '<p class="empty">无参数 —— 步骤里写了 ${参数名} 后在这里赋值</p>';
}

$('#btn-add-param').addEventListener('click', () => {
  caseData.params.push({ k: '', v: '' });
  renderParams();
});
$('#param-rows').addEventListener('click', (e) => {
  if (!e.target.classList.contains('p-del')) return;
  const row = e.target.closest('.param-row');
  caseData.params.splice(Number(row.dataset.i), 1);
  renderParams();
});
$('#param-rows').addEventListener('input', (e) => {
  const row = e.target.closest('.param-row');
  if (!row) return;
  const p = caseData.params[Number(row.dataset.i)];
  if (!p) return;
  if (e.target.classList.contains('p-k')) p.k = e.target.value;
  else if (e.target.classList.contains('p-v')) p.v = e.target.value;
});

// ---------------------------------------------------------------- steps events
function setBusy(v) {
  busy = v;
  $('#btn-run-case').disabled = v;
  $('#btn-run-case').textContent = v ? '执行中…' : '运行用例 ▶';
  $('#btn-run-case').classList.toggle('busy', v);
  $('#btn-run-selected').disabled = v || !selectedFiles.size;
  $('#btn-run-selected').classList.toggle('busy', v);
}

function stepBody(s) {
  const cfg = ACTIONS[s.action];
  if (!cfg) throw new Error(`未知动作：${s.action}`);
  const prompt = String(s.prompt ?? '');
  const value = String(s.value ?? '');
  const xpath = String(s.xpath ?? '');
  // 未赋值的 ${name} 明确报错；${{ENV}} 是官方环境变量语法，留给 runner 解析
  const missing = [...`${prompt} ${value} ${xpath}`.replace(ENV_RE, '').matchAll(PARAM_RE)]
    .map((m) => paramKeyOf(m[1], m[2]))
    .filter(Boolean);
  if (missing.length) {
    const uniq = [...new Set(missing)];
    throw new Error(`参数未提供值：${uniq.map((n) => '$' + '{' + n + '}').join(', ')} —— 请在该步骤行内传参（如 ${uniq[0]}=值）或先用例参数面板赋值`);
  }
  const body = { action: s.action, prompt: prompt.trim() };
  if (cfg.value && value.trim()) body.value = value.trim();
  if (cfg.xpath && xpath.trim()) body.xpath = xpath.trim();
  return body;
}

async function runOne(step, stepNo) {
  const cfg = ACTIONS[step.action] ?? { label: step.action };
  try {
    const r = await api('/api/run', stepBody(step));
    if (r.screenshot) setShot(r.screenshot);
    addCard({ ...r, stepNo, actionLabel: cfg.label });
    return r.ok !== false;
  } catch (err) {
    addCard({ prompt: step.prompt, action: step.action, actionLabel: cfg.label, stepNo, tier: '3-ai', error: err.message, ms: 0 });
    return false;
  }
}

function isValidStep(s) {
  if (isSemStep(s)) return semanticByName(s.action.slice(SEMANTIC_PREFIX.length)) != null;
  return String(s.prompt).trim() !== '' || (ACTIONS[s.action].value && String(s.value).trim() !== '');
}

async function runCase() {
  if (busy) return;
  const valid = caseData.steps.filter(isValidStep);
  if (!valid.length) { $('#steps').querySelector('.s-prompt')?.focus(); return; }
  // 用例参数中的多值（如 name=1|2）→ 整套用例逐值执行多轮
  let allRounds;
  try {
    allRounds = expandCaseRounds(valid); // 仅被步骤引用的参数参与轮次
  } catch (err) {
    addNoteCard(`✕ ${err.message}`);
    return;
  }
  if (!allRounds.length) return;
  setBusy(true);
  resetFeed();
  try {
    const total = allRounds.reduce((n, r) => n + r.length, 0);
    addNoteCard(`▶ 运行用例：${valid.length} 步 → ${allRounds.length} 轮 / 共 ${total} 个原子步骤`);
    let no = 0;
    for (let r = 0; r < allRounds.length; r++) {
      if (allRounds.length > 1) addNoteCard(`— 第 ${r + 1}/${allRounds.length} 轮 —`);
      await resetAgentSession();
      for (const step of allRounds[r]) {
        no += 1;
        const ok = await runOne(step, no);
        if (!ok) { addNoteCard(`步骤 ${no} 失败，已停止（bail）`); return; }
      }
    }
    addNoteCard(`✓ 用例执行完成（${no} 步 / ${allRounds.length} 轮）`);
  } catch (err) {
    addNoteCard(`✕ ${err.message}`);
  } finally {
    setBusy(false);
    refreshState();
  }
}

async function saveCaseYaml() {
  const title = caseData.title.trim() || '未命名用例';
  const group = $('#case-group').value.trim();
  const valid = caseData.steps.filter(isValidStep);
  if (!valid.length) { alert('请先添加至少一个有效步骤'); return; }
  let expanded;
  try {
    expanded = flattenRounds(expandCaseRounds(valid)); // 语义展开 + 多值参数逐值展开 → 所有轮次的步骤都落盘
    // 对齐官方：${name} 未赋值时不允许生成 YAML（官方在收集阶段即报错）
    const unresolved = [...new Set(expanded.flatMap((st) => [
      ...unresolvedParams(st.prompt), ...unresolvedParams(st.value), ...unresolvedParams(st.xpath),
    ]))];
    if (unresolved.length) {
      alert(`保存失败：参数未赋值 ${unresolved.map((n) => '$' + '{' + n + '}').join(', ')}。请先在「用例参数」面板或步骤行内赋值（官方 ${'$'}{name} 变量在收集阶段即要求有定义）。`);
      return;
    }
  } catch (err) { alert(err.message); return; }
  try {
    const r = await api('/api/case/save', {
      title,
      group,
      file: currentFile, // 编辑已有用例时覆盖原文件
      params: caseData.params, // 参数值随用例持久化（.params.json）
      steps: expanded.map((s) => ({ action: s.action, prompt: String(s.prompt).trim(), xpath: String(s.xpath).trim(), value: String(s.value).trim() })),
    });
    currentFile = r.file;
    currentGroup = r.dir || '';
    addNoteCard(`✓ 已保存 ${r.file}（分组：${r.dir || '默认'}；语义已展开为 ${expanded.length} 个原子步骤，参数已替换）—— 可点击右侧回归或纳入 pnpm test`);
    loadCases();
  } catch (err) {
    addNoteCard(`✕ 保存失败：${err.message}`);
  }
}

// ---------------------------------------------------------------- events
$('#steps').addEventListener('click', (e) => {
  const row = e.target.closest('.step');
  if (!row) return;
  const id = row.dataset.id;
  const idx = caseData.steps.findIndex((s) => s.id === id);
  if (idx < 0) return;
  if (e.target.classList.contains('s-del')) {
    caseData.steps.splice(idx, 1);
    if (!caseData.steps.length) caseData.steps.push(defaultStep());
    renderSteps();
  } else if (e.target.classList.contains('s-up') && idx > 0) {
    [caseData.steps[idx - 1], caseData.steps[idx]] = [caseData.steps[idx], caseData.steps[idx - 1]];
    renderSteps();
  } else if (e.target.classList.contains('s-down') && idx < caseData.steps.length - 1) {
    [caseData.steps[idx + 1], caseData.steps[idx]] = [caseData.steps[idx], caseData.steps[idx + 1]];
    renderSteps();
  } else if (e.target.classList.contains('s-run')) {
    if (!busy) {
      setBusy(true);
      resetFeed();
      (async () => {
        try {
          const s = caseData.steps[idx];
          const expanded = flattenRounds(expandCaseRounds([s]));
          for (let i = 0; i < expanded.length; i++) {
            const ok = await runOne(expanded[i], i + 1);
            if (!ok) { addNoteCard(`步骤 ${i + 1} 失败，已停止（bail）`); return; }
          }
        } catch (err) {
          addNoteCard(`✕ ${err.message}`);
        } finally {
          setBusy(false);
          refreshState();
        }
      })();
    }
  }
});

$('#steps').addEventListener('change', (e) => {
  const row = e.target.closest('.step');
  if (!row || !e.target.classList.contains('s-action')) return;
  const s = caseData.steps.find((x) => x.id === row.dataset.id);
  if (!s) return;
  s.action = e.target.value;
  saveCaseLocal();
  renderSteps(); // 重新渲染 value/xpath 可见性
});

$('#steps').addEventListener('input', (e) => {
  const row = e.target.closest('.step');
  if (!row) return;
  const s = caseData.steps.find((x) => x.id === row.dataset.id);
  if (!s) return;
  if (e.target.classList.contains('s-prompt')) s.prompt = e.target.value;
  else if (e.target.classList.contains('s-value')) s.value = e.target.value;
  else if (e.target.classList.contains('s-xpath')) s.xpath = e.target.value;
  saveCaseLocal();
});

$('#case-title').addEventListener('input', (e) => { caseData.title = e.target.value; saveCaseLocal(); });
$('#btn-add-step').addEventListener('click', () => { caseData.steps.push(defaultStep()); renderSteps(); saveCaseLocal(); });
$('#btn-run-case').addEventListener('click', runCase);
$('#btn-save-case').addEventListener('click', saveCaseYaml);
$('#btn-go').addEventListener('click', async () => {
  const url = $('#url').value.trim();
  if (!url || busy) return;
  setBusy(true);
  try { await api('/api/navigate', { url: url.startsWith('http') ? url : `https://${url}` }); }
  catch (err) { alert(`导航失败：${err.message}`); }
  finally { setBusy(false); refreshState(); }
});
$('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btn-go').click(); });
$('#shot').addEventListener('click', refreshState);

// ---------------------------------------------------------------- init
loadCase();
$('#case-title').value = caseData.title;
(async () => {
  await loadSemantics();  // 语义先加载，动作下拉才能包含「业务语义」分组
  renderSteps();
  renderSemantics();
  renderParams();
})();
refreshState();
loadCases();
