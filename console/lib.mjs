/**
 * 定位控制台 — 纯函数模块（从 server.mjs 提取，便于单元测试）
 *
 * 只包含无 IO / 无浏览器 / 无副作用的解析与变换逻辑；
 * readCacheRecords / runAction / saveCaseYaml / listCases 等 IO 与驱动函数留在 server.mjs。
 * 函数体与 server.mjs 原实现保持一致，行为不变。
 */

// ---------------------------------------------------------------- 动作语义全集
// 定位类动作（携带 locatePrompt，参与三层缓存判定；prompt 可留空者为整页动作）
export const LOCATING_ACTIONS = new Set([
  'tap', 'doubleClick', 'middleClick', 'rightClick', 'hover', 'longPress',
  'input', 'clearInput', 'keyboardPress', 'scroll', 'locate',
]);
// 语义类动作（纯自然语言，无元素定位）
export const SEMANTIC_LABEL = {
  act: '执行任务', assert: '断言', waitFor: '等待条件', boolean: '布尔判断',
  query: '提取数据', number: '数字提取', string: '文本提取', ask: '提问',
};
// YAML 节点映射（与 midscene-node-spec.web.md 的 schema 一致）
export const ACTION_NODES = {
  tap: { node: 'aiTap', xpath: true }, doubleClick: { node: 'aiDoubleClick', xpath: true },
  middleClick: { node: 'aiMiddleClick', xpath: true }, rightClick: { node: 'aiRightClick', xpath: true },
  hover: { node: 'aiHover', xpath: true }, longPress: { node: 'aiLongPress', xpath: true },
  input: { node: 'aiInput', xpath: true }, clearInput: { node: 'aiClearInput', xpath: true },
  keyboardPress: { node: 'aiKeyboardPress', xpath: true }, scroll: { node: 'aiScroll', xpath: true },
  locate: { node: 'aiLocate', xpath: true }, act: { node: 'aiAct', xpath: false },
  assert: { node: 'aiAssert', xpath: false }, waitFor: { node: 'aiWaitFor', xpath: false },
  boolean: { node: 'aiBoolean', xpath: false }, query: { node: 'aiQuery', xpath: false },
  number: { node: 'aiNumber', xpath: false }, string: { node: 'aiString', xpath: false },
  ask: { node: 'aiAsk', xpath: false },
};

export const NODE_TO_ACTION = Object.fromEntries(
  Object.entries(ACTION_NODES).map(([action, cfg]) => [cfg.node, action])
);

// ---------------------------------------------------------------- YAML 标量去引号
/**
 * 去掉 YAML 标量的外层引号：
 *  - 双引号标量按 JSON 语义解码转义（"\n"、"\\"、unicode 等）；
 *  - 单引号标量按 YAML 1.2 §7.3.2 处理：内部 '' 表示一个字面单引号。
 * Midscene 的缓存文件与 Workflow YAML 都由 js-yaml 4.x dump（task-cache.ts 用
 * js_yaml.dump(cacheToWrite, { lineWidth: -1 })），含冒号/井号等字符时会被 dump 成
 * 单引号标量，例如 prompt `a: it's` → `'a: it''s'`；因此这里必须按 YAML 规则还引号，
 * 否则会把 `it''s` 当成真实文本回读（缓存命中失败、用例文本被改写）。
 */
function unquoteScalar(raw) {
  const text = String(raw ?? '').trim();
  if (/^".*"$/.test(text)) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (/^'.*'$/.test(text)) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

// ---------------------------------------------------------------- cache 解析
/** 解析 Midscene 缓存文件（仅取 locate 记录；cache 文件的 caches[] 里同时存在 plan 记录） */
export function parseCache(text) {
  const records = [];
  if (!text) return records;
  let current = null;
  let inXpaths = false;
  for (const line of text.split(/\r?\n/)) {
    const typeMatch = line.match(/^  - type: (\w+)\s*$/);
    if (typeMatch) {
      // 只收集 locate 记录。plan 等其它类型必须显式断开 current，
      // 否则它的 prompt: 行会覆盖上一条 locate 记录的 prompt。
      if (typeMatch[1] === 'locate') {
        current = { prompt: '', xpaths: [] };
        records.push(current);
      } else {
        current = null;
      }
      inXpaths = false;
      continue;
    }
    if (!current) continue;
    const promptMatch = line.match(/^    prompt: (.*)$/);
    if (promptMatch) {
      current.prompt = String(unquoteScalar(promptMatch[1]));
      inXpaths = false;
      continue;
    }
    if (/^      xpaths:\s*$/.test(line)) { inXpaths = true; continue; }
    if (inXpaths) {
      const xpathMatch = line.match(/^        - (.+)$/);
      if (xpathMatch) current.xpaths.push(xpathMatch[1].trim());
      else if (line.trim() && !line.startsWith('        ')) inXpaths = false;
    }
  }
  return records;
}

export function recordsForPrompt(records, prompt) {
  return records.filter((r) => r.prompt === prompt);
}

export function snapshotOf(records, prompt) {
  return JSON.stringify(recordsForPrompt(records, prompt).map((r) => r.xpaths));
}

// ---------------------------------------------------------------- 用例 YAML 保存
function yamlString(s) {
  return JSON.stringify(String(s)); // JSON 双引号标量是合法的 YAML 1.2
}

export function buildCaseYaml({ title, steps, url }) {
  const lines = [];
  lines.push('# 由定位控制台生成（测试用例格式：标题 + 步骤 + 每步可选 xpath）');
  // beforeEach 是文件级 Workflow Document 生命周期步骤（midscene-node-spec.web.md：
  // "Call a Node in cases[].steps, or in the Workflow Document lifecycle steps
  // beforeAll/beforeEach/afterEach/afterAll"）。写在 case 内会被 runner 拒绝：
  // "Case 1 has unsupported field \"beforeEach\""。
  if (url) {
    lines.push('beforeEach:');
    lines.push(`  - gotoUrl: ${yamlString(url)}`);
  }
  lines.push('cases:');
  lines.push(`  - name: ${yamlString(title)}`);
  lines.push('    tags: [console]');
  lines.push('    steps:');
  for (const s of steps) {
    const cfg = ACTION_NODES[s.action];
    if (!cfg) throw new Error(`未知动作：${s.action}`);
    lines.push(`      - ${cfg.node}:`);
    if (s.prompt) lines.push(`          prompt: ${yamlString(s.prompt)}`);
    if (s.action === 'input') lines.push(`          value: ${yamlString(s.value)}`);
    if (s.action === 'keyboardPress') lines.push(`          keyName: ${yamlString(s.value)}`);
    if (s.action === 'scroll') {
      const parts = String(s.value || 'down').trim().split(/\s+/);
      lines.push('          options:');
      lines.push(`            direction: ${yamlString(parts[0])}`);
      const dist = Number(parts[1]);
      if (Number.isFinite(dist) && dist > 0) lines.push(`            distance: ${dist}`);
      if (s.xpath) lines.push(`            xpath: ${yamlString(s.xpath)}`);
      continue;
    }
    if (s.xpath && cfg.xpath) {
      lines.push('          options:');
      lines.push(`            xpath: ${yamlString(s.xpath)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export function yamlScalar(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/^".*"$/.test(text) || /^'.*'$/.test(text)) return unquoteScalar(text);
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

/** 解析控制台生成的用例 YAML（cases/ - name / beforeEach gotoUrl / steps / - aiXxx: 结构）
 *  兼容两种 beforeEach 位置：文件级（0 缩进，新格式，gotoUrl 应用于全文件用例）
 *  与 case 级（4 缩进，旧格式，仅该用例）。 */
export function parseCaseYaml(text) {
  const cases = [];
  let current = null;
  let step = null;
  let section = '';
  let inOptions = false;
  let fileUrl = '';
  let fileLevel = false; // 当前 beforeEach 段是否为文件级（0 缩进）
  for (const line of text.split(/\r?\n/)) {
    if (/^  - name: /.test(line)) {
      current = { name: yamlScalar(line.slice(9)), steps: [], url: fileUrl };
      cases.push(current);
      step = null;
      section = '';
      inOptions = false;
      continue;
    }
    // 文件级 lifecycle 段（0 缩进）：先于 current 守卫处理
    if (/^beforeEach:\s*$/.test(line)) { section = 'beforeEach'; fileLevel = true; continue; }
    if (/^(beforeAll|afterEach|afterAll):\s*$/.test(line)) { section = ''; continue; }
    if (/^(cases|setup|nodes|projects):\s*$/.test(line)) { section = ''; fileLevel = false; continue; }
    if (/^(\s+)- gotoUrl: (.*)$/.test(line) && section === 'beforeEach') {
      const u = String(yamlScalar(line.replace(/^(\s+)- gotoUrl: /, '')));
      if (fileLevel) fileUrl = u;
      else if (current) current.url = u;
      continue;
    }
    if (!current) continue;
    if (/^    beforeEach:\s*$/.test(line)) { section = 'beforeEach'; continue; }
    if (/^    steps:\s*$/.test(line)) { section = 'steps'; continue; }
    if (section !== 'steps') continue;
    if (/^      - (\w+):\s*$/.test(line)) {
      const node = line.trim().slice(2, -1);
      const action = NODE_TO_ACTION[node];
      if (action) { step = { action, prompt: '', xpath: '', value: '' }; current.steps.push(step); }
      else step = null;
      inOptions = false;
      continue;
    }
    if (!step) continue;
    if (/^          options:\s*$/.test(line)) { inOptions = true; continue; }
    if (/^          (\w+): (.*)$/.test(line)) {
      const [, key, raw] = line.match(/^          (\w+): (.*)$/);
      if (key === 'prompt') step.prompt = String(yamlScalar(raw));
      else if (key === 'value') step.value = String(yamlScalar(raw));
      else if (key === 'keyName') step.value = String(yamlScalar(raw));
      continue;
    }
    if (inOptions && /^            (\w+): (.*)$/.test(line)) {
      const [, key, raw] = line.match(/^            (\w+): (.*)$/);
      if (key === 'xpath') step.xpath = String(yamlScalar(raw));
      else if (key === 'direction') step.value = `${yamlScalar(raw)}${step.value ? ' ' + step.value : ''}`;
      else if (key === 'distance') step.value = `${step.value} ${raw}`.trim();
      continue;
    }
    if (line.trim() && !line.startsWith('            ')) inOptions = false;
  }
  return cases;
}
