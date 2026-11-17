/**
 * 定位控制台 E2E —— Playwright 驱动真实 UI（普通脚本：顶层 await + try/finally，非 node:test）
 *
 * 目标：对「参数语法 ${} / 数据驱动 / 业务语义面板 / 参数持久化」大改后的控制台做流程级验证，
 *       覆盖 9 组必测流程（分组折叠、全选联动、禁用光标、结果栏按次隔离、语义面板、
 *       ${} 未赋值拦截、步骤编辑器、✎ 编辑回填、右栏内部滚动）。
 *
 * 前置（重要）：cases/ 根目录当前没有 .yaml 用例，右侧用例库会是空的 —— 旧版 E2E 直接
 *   `waitForSelector('.case-group .case-item')` 必然 15s 超时。所以本脚本先用
 *   POST /api/case/save 造 e2e-tmp* 分组 fixture（11 个文件 / 10 个分组），再打开 UI 断言；
 *   结束时删除全部 fixture 文件并移除 e2e-tmp* 空目录（只删自己造的目录，不动 demo/测试展开/验证参数）。
 *
 * 安全边界：
 *   - 自建 23368 实例（CONSOLE_PORT=23368、HEADLESS=true、强制 fresh 浏览器上下文），
 *     绝不接管用户正在用的 23366 实例与 9222 调试 Chrome；
 *   - 不触发真实 AI 定位。执行类断言只走两条零 AI 路径：
 *       ① 参数未赋值 → 前端在发请求前就抛「参数未提供值」（零网络、~百毫秒）；
 *       ② 命中既有定位缓存的 input 步骤 → Tier 2（~1.2s，零 AI 调用）。
 *          目标页是本地 data: URL，其 DOM 结构与缓存 xpath 对齐
 *          （/html/body/section[1]/header[1]/input[1] → <section><header><input>）；
 *   - 「▶ 回归选中」的点击联动用 page.route 打桩 /api/case/run，只验前端请求与渲染，
 *     不真的跑用例（真实批量回归属于集成/E2E 之外的昂贵路径）；
 *   - 共享定位缓存 midscene_run/cache/web-locate-chain.cache.yaml 只读复用（命中不写盘）：
 *     已存在则原样复用并在结束时校验/按快照还原；不存在（例如刚清空过 midscene_run/）则
 *     按 Midscene 1.17.4 格式写入最小 seed fixture，结束时删除该文件 → 脚本在任何干净检出上都可跑；
 *   - console/semantics/demo2.json 是用户数据：本脚本只读断言、绝不写入或改写
 *     （语义面板相关用例全部使用自建的 e2e-tmp-sem / e2e-tmp-env 并在用后删除），
 *     结束时校验其内容与运行前逐字节一致。
 *
 * 运行：node console/test/e2e.mjs   （任意目录可跑，工程根由 import.meta.url 推导）
 *      端口可用 E2E_PORT 覆盖（默认 23368）。
 */
import { spawn, execSync } from 'node:child_process';
import { rmdir, readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SERVER_ENTRY = join(ROOT, 'console', 'server.mjs');
const PORT = Number(process.env.E2E_PORT || 23368);
const BASE = `http://127.0.0.1:${PORT}`;
const CASES_DIR = join(ROOT, 'cases');
const SEM_DIR = join(ROOT, 'console', 'semantics');
const DEMO2_FILE = join(SEM_DIR, 'demo2.json'); // 用户数据：只读
const CACHE_FILE = join(ROOT, 'midscene_run', 'cache', 'web-locate-chain.cache.yaml');
const GROUP = 'e2e-tmp';
// 共享缓存里既有的定位记录（只读复用 → Tier 2 缓存命中，零 AI 调用）
const CACHED_PROMPT = 'the new todo input field';
const CACHED_XPATH = '/html/body/section[1]/header[1]/input[1]';
// 缓存缺失时自建的最小 fixture（与 Midscene 1.17.4 的 task-cache dump 格式一致）
const CACHE_RECORD = [
  '  - type: locate',
  `    prompt: ${CACHED_PROMPT}`,
  '    cache:',
  '      xpaths:',
  `        - ${CACHED_XPATH}`,
].join('\n');
const CACHE_SEED = [
  'midsceneVersion: 1.17.4',
  'cacheId: web-locate-chain',
  'caches:',
  CACHE_RECORD,
  '',
].join('\n');
// 语义面板用例全部用自建名（demo2 是用户数据，只读不动）
const SEM_TMP = 'e2e-tmp-sem';
const SEM_ENV = 'e2e-tmp-env';
// 目标页 fixture：结构与 CACHED_XPATH 对齐，供 Tier 2 缓存重解析通过
const TARGET_HTML = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<style>body{font-family:sans-serif;padding:8px}input{width:240px;height:32px;display:block}',
  'button{width:80px;height:28px}</style></head><body>',
  '<section><header><input id="todo" placeholder="What needs to be done?"></header>',
  '<ul><li>one</li><li>two</li></ul><button id="add">Add</button></section>',
  '</body></html>',
].join('');
const TARGET_URL = `data:text/html;charset=utf-8,${encodeURIComponent(TARGET_HTML)}`;

// ---------------------------------------------------------------- 微型断言框架
const passList = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const section = (t) => console.log(`\n== ${t} ==`);
function ok(cond, label) {
  if (!cond) throw new Error(`断言失败：${label}`);
  passList.push(label);
  console.log(`  ✓ [${String(passList.length).padStart(2, '0')}] ${label}`);
}

// ---------------------------------------------------------------- HTTP 客户端
async function api(path, body) {
  const res = await fetch(BASE + path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(`${path} → ${data.error || `HTTP ${res.status}`}`);
  return data;
}

async function isReachable() {
  try {
    const res = await fetch(`${BASE}/`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- 服务子进程
let server = null;
let serverOutput = '';

function startServer() {
  server = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONSOLE_PORT: String(PORT),
      HEADLESS: 'true',
      // 强制 fresh 上下文：清空 CDP 地址，绝不让本实例去接管用户的 9222 调试 Chrome
      CONSOLE_CDP_URL: '',
      CONSOLE_INTERACTIVE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', (d) => { serverOutput += d; });
  server.stderr.on('data', (d) => { serverOutput += d; });
}

/** 连同 chromium 孙进程一起结束（Windows 必须 taskkill /T，否则 node 退出后 chromium 变孤儿） */
function killServer() {
  if (!server) return false;
  const pid = server.pid;
  try {
    if (process.platform === 'win32') execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    else server.kill('SIGTERM');
  } catch { /* 已退出 */ }
  server = null;
  return true;
}

// ---------------------------------------------------------------- fixture（用例文件）
const created = []; // [{ file, group }] —— 统一清理

function buildFixtures() {
  const list = [
    {
      group: GROUP,
      title: 'e2e-fixture',
      steps: [
        { action: 'tap', prompt: '点击待办输入框' },
        { action: 'assert', prompt: '断言页面展示待办列表' },
      ],
      params: [{ k: 'name', v: '张三' }],
    },
    {
      group: GROUP,
      title: 'e2e-fixture-2',
      steps: [{ action: 'input', prompt: '在搜索框输入关键词', value: 'hello e2e' }],
    },
  ];
  // 额外 9 个分组：让右侧列表超出可视高度，才能验「分组过多时内部滚动」
  for (let i = 2; i <= 10; i += 1) {
    const s = String(i).padStart(2, '0');
    list.push({
      group: `e2e-tmp-${s}`,
      title: `e2e-fixture-g${s}`,
      steps: [{ action: 'tap', prompt: `点击第 ${i} 个按钮` }],
    });
  }
  return list;
}

/** 按用例名在全部分组里找落盘文件（找不到返回 null）——不限定分组，避免“存到别处”时漏清理 */
async function findCaseFileByName(name, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const data = await api('/api/cases');
    for (const g of data.groups || []) {
      const f = (g.files || []).find((x) => (x.cases || []).some((c) => c.name === name));
      if (f) return f.file;
    }
    await sleep(300);
  }
  return null;
}

async function cleanupFixtures() {
  const removed = [];
  const targets = new Set(created.map((f) => f.file));
  const groups = new Set(created.map((f) => f.group).filter(Boolean));
  // 兜底：把 e2e-tmp* 分组里剩下的文件也删掉（该前缀只由本脚本创建）
  const data = await api('/api/cases').catch(() => ({ groups: [] }));
  for (const g of data.groups || []) {
    if (!g.group.startsWith('e2e-tmp')) continue;
    groups.add(g.group);
    for (const f of g.files || []) targets.add(f.file);
  }
  for (const file of targets) {
    try { await api('/api/case/delete', { file }); removed.push(file); } catch { /* 已不存在 */ }
  }
  const dirs = [...groups].sort();
  for (const d of dirs) await rmdir(join(CASES_DIR, d)).catch(() => {});
  return { removed, dirs };
}

// ================================================================ 主流程
let browser = null;
let page = null;
let cacheBaseline = null;
let cacheSeeded = false;
const demo2Baseline = existsSync(DEMO2_FILE) ? await readFile(DEMO2_FILE, 'utf8') : null;
const startedAt = Date.now();

try {
  // ---------------------------------------------------------------- 0) 启动 + fixture
  section('0) 启动控制台实例 + 造 fixture（旧版 E2E 就死在「cases/ 为空」这一步）');
  if (await isReachable()) throw new Error(`端口 ${PORT} 已被占用（疑似残留实例），请先释放后重试`);
  startServer();

  const readyDeadline = Date.now() + 40000;
  let ready = false;
  while (Date.now() < readyDeadline) {
    if (await isReachable()) { ready = true; break; }
    if (server.exitCode !== null) throw new Error(`服务进程提前退出（code=${server.exitCode}）\n${serverOutput}`);
    await sleep(300);
  }
  if (!ready) throw new Error(`40s 内服务未就绪\n${serverOutput}`);
  ok(true, `spawn 控制台实例（CONSOLE_PORT=${PORT}、HEADLESS=true、fresh 上下文）并 40s 内就绪`);

  // Tier 2 前置：缓存既有记录 → 只读复用；缓存不存在 → 写最小 seed（用后删除）；
  // 缓存存在但缺该记录 → 追加一条（用后按快照还原）。
  cacheBaseline = existsSync(CACHE_FILE) ? await readFile(CACHE_FILE, 'utf8') : null;
  const cacheHasRecord = (cacheBaseline ?? '').includes(CACHED_PROMPT) && (cacheBaseline ?? '').includes(CACHED_XPATH);
  if (!cacheHasRecord) {
    await mkdir(join(ROOT, 'midscene_run', 'cache'), { recursive: true });
    if (cacheBaseline == null) {
      await writeFile(CACHE_FILE, CACHE_SEED, 'utf8');
      cacheSeeded = true;
    } else {
      await writeFile(CACHE_FILE, `${cacheBaseline.replace(/\n?$/, '\n')}${CACHE_RECORD}\n`, 'utf8');
    }
  }
  const cacheText = await readFile(CACHE_FILE, 'utf8');
  ok(
    cacheText.includes(CACHED_PROMPT) && cacheText.includes(CACHED_XPATH),
    `前置：定位缓存含 e2e 依赖的 Tier 2 记录（prompt=「${CACHED_PROMPT}」）—— ${
      cacheSeeded ? '缓存缺失，已写入最小 seed fixture（收尾删除）'
        : cacheHasRecord ? '只读复用既有缓存（命中不写盘）' : '既有缓存缺该记录，已追加一条（收尾按快照还原）'
    }`,
  );
  ok(!cacheSeeded || cacheText === CACHE_SEED, cacheSeeded ? 'seed fixture 与 Midscene 1.17.4 缓存格式一致（收尾会删除该文件）' : '未注入 seed（复用既有缓存，收尾按运行前快照校验）');
  ok(
    demo2Baseline == null || demo2Baseline.includes('"name": "demo2"'),
    '前置：console/semantics/demo2.json 为已存在的用户数据（本脚本只读断言，绝不改写）',
  );

  // 既有用例（用户/其他套件留下的）不计入 fixture，但会让右侧多出条目/分组 ——
  // 断言按「fixture + 既有」动态计算，脚本在非空工程与干净工程上都成立。
  const preList = await api('/api/cases');
  const preFiles = (preList.groups || [])
    .filter((g) => !g.group.startsWith('e2e-tmp'))
    .flatMap((g) => (g.files || []).map((f) => f.file));
  const preGroups = (preList.groups || []).filter((g) => !g.group.startsWith('e2e-tmp')).length;
  const expectedItems = preFiles.length + 11;
  const expectedGroups = preGroups + 10;
  // 既有 cases/ 子目录快照（清理只允许移除自己造的 e2e-tmp*）
  const preDirs = (await readdir(CASES_DIR).catch(() => [])).filter((n) => !n.startsWith('e2e-tmp')).sort();

  for (const fx of buildFixtures()) {
    const saved = await api('/api/case/save', { title: fx.title, group: fx.group, steps: fx.steps, params: fx.params });
    created.push({ file: saved.file, group: fx.group });
  }
  ok(created.length === 11, `POST /api/case/save 造 fixture：${created.length} 个用例文件（10 个分组）`);
  const list0 = await api('/api/cases');
  const e2eGroups = (list0.groups || []).filter((g) => g.group.startsWith('e2e-tmp'));
  ok(e2eGroups.length === 10, `GET /api/cases 检出 ${e2eGroups.length} 个 e2e-tmp* 分组`);
  ok(expectedItems === 11 + preFiles.length, `预期用例条目 = fixture 11 + 既有 ${preFiles.length} = ${expectedItems}`);
  const f1 = created[0].file;

  // ---------------------------------------------------------------- 打开页面
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 800 } });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#case-groups .case-item', { state: 'attached', timeout: 20000 });
  await page.waitForFunction((n) => document.querySelectorAll('#case-groups .case-item').length === n, expectedItems, { timeout: 20000 });
  const itemCount = await page.locator('#case-groups .case-item').count();
  ok(itemCount === expectedItems, `Playwright 打开控制台，渲染 ${itemCount} 个用例条目（fixture 11 + 既有 ${preFiles.length}，不再 15s 超时）`);
  await page.waitForSelector('#steps .step', { timeout: 10000 }); // 编辑器由 init 的异步 IIFE 首次渲染
  ok((await page.locator('#steps .step').count()) === 1, '编辑器初始为 1 个默认步骤行');
  ok((await page.inputValue('#case-title')) === '', '编辑器初始标题为空（编辑状态不持久化）');
  ok((await page.locator('#param-rows .empty').count()) === 1, '参数面板初始为空态提示（无参数）');

  // ---------------------------------------------------------------- 工具函数（依赖 page）
  const row = (n) => `#steps .step:nth-child(${n})`;
  const feedText = () => page.locator('#feed').innerText();
  const successCount = () => page.evaluate(() => (document.querySelector('#feed').innerText.match(/✓ 已保存/g) || []).length);
  const groupSel = `.case-group[data-group="${GROUP}"]`;

  /**
   * 触发一个 dialog（alert / prompt / confirm）并接管它：
   *   opts.dismiss=true → 取消；opts.value!==undefined → accept(value)；否则 accept()
   * 注意：模态 dialog 会阻塞页面 JS，page.click 在 dialog 被处理前不会 resolve，
   *       因此「点击」与「dialog 处理」必须并行推进（不能先 await 点击再 await dialog）。
   */
  async function withDialog(trigger, opts = {}) {
    const handled = page.waitForEvent('dialog', { timeout: opts.timeout ?? 15000 })
      .catch(() => null)
      .then(async (d) => {
        if (!d) throw new Error(`期望弹出 dialog，但没有弹出（${opts.kind || 'any'}）`);
        let defaultValue = '';
        try { defaultValue = d.defaultValue(); } catch { /* alert/confirm 无默认值 */ }
        const info = { type: d.type(), message: d.message(), defaultValue };
        if (opts.dismiss) await d.dismiss();
        else if (opts.value !== undefined) await d.accept(opts.value);
        else await d.accept();
        return info;
      });
    const triggerP = trigger();
    triggerP.catch(() => { /* dialog 未出现时避免悬挂 Promise 变成未处理拒绝 */ });
    const info = await handled;
    await triggerP;
    return info;
  }

  /** 点「保存」并等到出现新的「✓ 已保存」回执（比等 CSS 类可靠：失败回执也是 .card.save） */
  async function clickSaveExpectSuccess(label) {
    const before = await successCount();
    await page.click('#btn-save-case');
    await page.waitForFunction((n) => (document.querySelector('#feed').innerText.match(/✓ 已保存/g) || []).length > n, before, { timeout: 20000 });
    ok(true, label);
  }

  // ================================================================ 1) 分组折叠/展开
  section('1) 右侧用例库分组折叠/展开（点组头切换 collapsed、localStorage 持久化、组头 checkbox 不误触折叠）');
  ok((await page.locator('#case-groups .case-group').count()) === expectedGroups, `右侧渲染 ${expectedGroups} 个分组`);
  ok((await page.locator(`${groupSel} .case-item`).count()) === 2, `${GROUP} 分组内渲染 2 个用例文件条目`);
  ok(!(await page.evaluate((s) => document.querySelector(s).classList.contains('collapsed'), groupSel)), '默认展开（无 .collapsed）');

  await page.click(`${groupSel} .group-name`);
  await page.waitForFunction((s) => document.querySelector(s)?.classList.contains('collapsed'), groupSel);
  ok(true, '点击组头（组名）→ 分组折叠（.collapsed）');
  ok((await page.locator(`${groupSel} .group-toggle`).innerText()).trim() === '▸', '折叠后折叠箭头变 ▸');
  ok(await page.locator(`${groupSel} .case-item`).first().isHidden(), '折叠后该组 .case-item 不可见（display:none）');
  const ls1 = await page.evaluate(() => JSON.parse(localStorage.getItem('locate-console-collapsed') || '[]'));
  ok(ls1.includes(GROUP), `折叠状态写入 localStorage（locate-console-collapsed=${JSON.stringify(ls1)}）`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  // 折叠中的 .case-item 是 display:none（attached 而非 visible），故用 attached 等待
  await page.waitForSelector('#case-groups .case-item', { state: 'attached', timeout: 20000 });
  await page.waitForFunction((n) => document.querySelectorAll('#case-groups .case-item').length === n, expectedItems, { timeout: 20000 });
  ok(
    await page.evaluate((s) => document.querySelector(s)?.classList.contains('collapsed') ?? false, groupSel),
    '刷新页面后分组仍保持折叠（localStorage 持久化生效）',
  );
  await page.click(`${groupSel} .group-name`);
  await page.waitForFunction((s) => !document.querySelector(s)?.classList.contains('collapsed'), groupSel);
  const ls2 = await page.evaluate(() => JSON.parse(localStorage.getItem('locate-console-collapsed') || '[]'));
  ok(!ls2.includes(GROUP), `再次点击组头 → 展开，localStorage 同步移除（${JSON.stringify(ls2)}）`);
  ok(await page.locator(`${groupSel} .case-item`).first().isVisible(), '展开后 .case-item 恢复可见');

  await page.click(`${groupSel} .group-sel`);
  await page.waitForFunction((s) => document.querySelector(`${s} .g-sel`)?.checked === true, groupSel);
  ok(
    !(await page.evaluate((s) => document.querySelector(s).classList.contains('collapsed'), groupSel)),
    '点击组头「选组」复选框不会误触折叠（click 冒泡被 .group-sel 拦截）',
  );
  ok((await page.locator(`${groupSel} .ci-cb:checked`).count()) === 2, '「选组」勾选该组全部 2 个文件');
  ok((await page.locator('#sel-info').innerText()).includes('已选 2 个文件'), '选择计数同步为「已选 2 个文件」');
  ok(await page.isEnabled('#btn-run-selected'), '有选中项时「▶ 回归选中」按钮可点');
  await page.click(`${groupSel} .group-sel`);
  await page.waitForFunction((s) => document.querySelector(`${s} .g-sel`)?.checked === false, groupSel);
  ok((await page.locator('#sel-info').innerText()).trim() === '未选择', '取消「选组」后选择计数回到「未选择」');

  // ================================================================ 2) 全选 → 回归选中
  section('2) 全选 → 「▶ 回归选中」由禁用变可点（历史 bug：绑定错位）');
  ok(await page.isDisabled('#btn-run-selected'), '（前置）未选择时按钮 disabled');
  await page.click('#sel-all');
  await page.waitForFunction(() => document.querySelector('#btn-run-selected')?.disabled === false);
  const allItems = await page.locator('#case-groups .case-item').count();
  const allChecked = await page.locator('#case-groups .ci-cb:checked').count();
  ok(allChecked === allItems && allItems === expectedItems, `「全选」勾选全部 ${allItems} 个用例文件（.ci-cb:checked=${allChecked}）`);
  ok(await page.isEnabled('#btn-run-selected'), '全选后「▶ 回归选中」由 disabled 变为可点');
  ok((await page.locator('#sel-info').innerText()).includes(`已选 ${allItems} 个文件`), '选择计数与勾选数一致');
  ok(await page.isChecked('#sel-all'), '#sel-all 自身保持勾选（updateSelInfo 回写）');

  // 点击联动：打桩 /api/case/run，验证点击确实按选中集合发出批量回归请求（不跑真实 AI 用例）
  let runReq = null;
  const stubRun = async (route) => {
    runReq = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true, total: 1, passedCount: 1,
        results: [{
          file: 'cases/e2e-tmp/stub.yaml', name: 'e2e-fixture', passed: true, ms: 12, total: 2, executed: 2,
          steps: [{ no: 1, action: 'tap', ok: true, tier: '2-cache', ms: 5, xpath: CACHED_XPATH }],
        }],
      }),
    });
  };
  await page.route('**/api/case/run', stubRun);
  await page.click('#btn-run-selected');
  await page.waitForSelector('#feed .card.t1', { timeout: 15000 });
  ok(Array.isArray(runReq?.files) && runReq.files.length === allItems, `点击「回归选中」→ POST /api/case/run（files=${runReq?.files?.length} 个文件）`);
  ok(runReq.files.includes(f1), '请求体包含 fixture 文件路径（选中集合正确传参，无绑定错位）');
  ok((await feedText()).includes('回归完成：1/1 通过'), '回归结果回执渲染「回归完成：1/1 通过」');
  ok((await page.locator('#feed .card.t1').first().innerText()).includes('Tier 2 · 缓存命中'), '回归卡片按步骤渲染层级徽标');
  await page.unroute('**/api/case/run', stubRun);

  await page.click('#sel-all');
  await page.waitForFunction(() => document.querySelector('#btn-run-selected')?.disabled === true);
  ok(await page.isDisabled('#btn-run-selected'), '取消全选后按钮回到 disabled');
  ok((await page.locator('#sel-info').innerText()).trim() === '未选择', '取消全选后选择计数回到「未选择」');

  // ================================================================ 3) 禁用光标
  section('3) 禁用按钮 cursor = not-allowed（历史 bug：误设 wait）');
  const curOff = await page.evaluate(() => {
    const b = document.querySelector('#btn-run-selected');
    return { disabled: b.disabled, cursor: getComputedStyle(b).cursor, busy: b.classList.contains('busy') };
  });
  ok(curOff.disabled === true && curOff.cursor === 'not-allowed', `禁用态 cursor=not-allowed（实测 ${curOff.cursor}）`);
  ok(curOff.busy === false, '禁用态未误加 .busy 类（wait 光标只保留给执行中）');
  await page.click('#sel-all');
  await page.waitForFunction(() => document.querySelector('#btn-run-selected')?.disabled === false);
  const curOn = await page.evaluate(() => getComputedStyle(document.querySelector('#btn-run-selected')).cursor);
  ok(curOn === 'pointer', `可点态 cursor=pointer（实测 ${curOn}）`);
  await page.click('#sel-all');
  await page.waitForFunction(() => document.querySelector('#btn-run-selected')?.disabled === true);

  // ================================================================ 7) 步骤编辑器
  section('7) 步骤编辑器：＋步骤、动作切换后 value/xpath 显隐、上下移、删除');
  ok((await page.locator('#steps .step').count()) === 1, '初始 1 行');
  await page.click('#btn-add-step');
  await page.waitForFunction(() => document.querySelectorAll('#steps .step').length === 2);
  ok(true, '点击「＋ 步骤」→ 行数 1 → 2');

  await page.selectOption(`${row(1)} .s-action`, 'assert');
  await page.waitForFunction(() => {
    const r = document.querySelector('#steps .step:first-child');
    return !!r && r.querySelector('.s-xpath')?.hidden === true && r.querySelector('.s-value')?.hidden === true;
  });
  ok(true, '动作切到 assert（检查类）→ .s-xpath 与 .s-value 均隐藏');
  await page.selectOption(`${row(1)} .s-action`, 'input');
  await page.waitForFunction(() => {
    const r = document.querySelector('#steps .step:first-child');
    return !!r && r.querySelector('.s-value')?.hidden === false && r.querySelector('.s-xpath')?.hidden === false;
  });
  ok(true, '动作切到 input（操作类）→ .s-value 与 .s-xpath 均显示');
  await page.selectOption(`${row(1)} .s-action`, 'tap');
  await page.waitForFunction(() => {
    const r = document.querySelector('#steps .step:first-child');
    return !!r && r.querySelector('.s-value')?.hidden === true && r.querySelector('.s-xpath')?.hidden === false;
  });
  ok(true, '动作切到 tap → .s-value 隐藏、.s-xpath 仍显示（定位类 xpath 可选）');

  const prompts = () => page.$$eval('#steps .step .s-prompt', (els) => els.map((e) => e.value));
  await page.fill(`${row(1)} .s-prompt`, 'AAA 第一步');
  await page.fill(`${row(2)} .s-prompt`, 'BBB 第二步');
  ok(JSON.stringify(await prompts()) === JSON.stringify(['AAA 第一步', 'BBB 第二步']), '两行 prompt 输入生效（AAA / BBB）');
  await page.click(`${row(2)} .s-up`);
  await page.waitForFunction(() => {
    const v = [...document.querySelectorAll('#steps .step .s-prompt')].map((e) => e.value);
    return v[0].startsWith('BBB') && v[1].startsWith('AAA');
  });
  ok(true, '第 2 行点 ↑ 上移 → 顺序变为 BBB → AAA');
  await page.click(`${row(1)} .s-down`);
  await page.waitForFunction(() => {
    const v = [...document.querySelectorAll('#steps .step .s-prompt')].map((e) => e.value);
    return v[0].startsWith('AAA') && v[1].startsWith('BBB');
  });
  ok(true, '第 1 行点 ↓ 下移 → 顺序恢复 AAA → BBB');
  await page.click(`${row(2)} .s-del`);
  await page.waitForFunction(() => document.querySelectorAll('#steps .step').length === 1);
  ok((await prompts())[0].startsWith('AAA'), '第 2 行点 ✕ 删除 → 行数 2 → 1，剩 AAA');
  await page.click(`${row(1)} .s-del`);
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('#steps .step');
    return rows.length === 1 && rows[0].querySelector('.s-prompt').value === '';
  });
  ok(true, '删除最后一行后自动补一个空行（行数保持 1、prompt 清空，不会出现 0 行空编辑器）');

  // ================================================================ 6) ${name} 参数语法
  section('6) ${name} 参数语法：未赋值执行拦截 / 未赋值保存拦截 / 赋值后替换并持久化 / ${{ENV}} 不计入参数');
  await page.fill(`${row(1)} .s-prompt`, '点击 ${paramA}');
  await page.fill('#case-title', 'e2e-参数用例');
  await page.click('#btn-run-case');
  await page.waitForFunction(() => document.querySelector('#feed')?.innerText.includes('参数未提供值'), null, { timeout: 15000 });
  const feedParamErr = await feedText();
  ok(feedParamErr.includes('参数未提供值') && feedParamErr.includes('${paramA}'), '未赋值的 ${paramA} → 执行报「参数未提供值：${paramA}」');
  ok((await page.locator('#feed .card.err').count()) >= 1, '结果栏出现失败卡片（.card.err，未发出 AI 定位请求）');

  const dlgSave = await withDialog(async () => { await page.click('#btn-save-case'); }, { dismiss: true, kind: 'alert' });
  ok(dlgSave.type === 'alert' && dlgSave.message.includes('参数未赋值') && dlgSave.message.includes('${paramA}'),
    `未赋值 \${paramA} 时保存被 alert 拦截：「${dlgSave.message.replace(/\n/g, ' ').slice(0, 46)}…」`);

  // 参数面板赋值 → 保存成功 → ${paramA} 被替换、参数随用例持久化
  await page.fill('#case-group', GROUP);
  await page.click('.case-params summary');
  await page.click('#btn-add-param');
  await page.waitForSelector('#param-rows .param-row');
  await page.fill('#param-rows .param-row .p-k', 'paramA');
  await page.fill('#param-rows .param-row .p-v', '世界');
  ok((await page.inputValue('#param-rows .param-row .p-k')) === 'paramA', '参数面板新增一行并填入 paramA');
  await clickSaveExpectSuccess('参数赋值后再点「保存」不再被拦截，出现「✓ 已保存」回执');
  const fileParam = await findCaseFileByName('e2e-参数用例');
  ok(!!fileParam, `落盘文件可被 /api/cases 检出（${fileParam ?? '未检出'}）`);
  ok(fileParam?.startsWith(`cases/${GROUP}/`), `文件落在所选分组目录（${fileParam}）`);
  created.push({ file: fileParam, group: GROUP });
  const loaded = await api('/api/case/load', { file: fileParam });
  ok(loaded.steps[0].prompt === '点击 世界', `落盘时 ${'${paramA}'} 已替换为参数值（prompt =「点击 世界」）`);
  ok(loaded.params.length === 1 && loaded.params[0].k === 'paramA' && loaded.params[0].v === '世界',
    '参数随用例持久化（.params.json 回读 paramA=世界）');

  // 多值参数（数据驱动）：保存时逐值展开为连续步骤（回归 2026-11：修复前只保存首值）
  await page.fill('#param-rows .param-row .p-v', '甲|乙');
  await clickSaveExpectSuccess('多值参数 paramA=甲|乙 保存成功');
  const multi = await api('/api/case/load', { file: fileParam });
  const multiPrompts = (multi.steps || []).map((s) => s.prompt);
  ok(multi.steps.length === 2 && multiPrompts[0] === '点击 甲' && multiPrompts[1] === '点击 乙',
    `多值参数逐值落盘为连续步骤（${JSON.stringify(multiPrompts)}）`);
  ok(multi.params.length === 1 && multi.params[0].v === '甲|乙',
    '多值表达式仍保存在 .params.json（侧车回读 paramA=甲|乙）');

  // ${{ENV}}：官方环境变量语法，不算用例参数、不拦截保存、原样落盘
  const fileCountBefore = (await api('/api/cases')).groups.find((g) => g.group === GROUP).files.length;
  await page.fill(`${row(1)} .s-prompt`, '点击 ${{E2E_ENV}} 按钮');
  await page.fill('#case-title', 'e2e-env用例');
  await clickSaveExpectSuccess('步骤写 ${{E2E_ENV}} 时保存不被拦截（环境变量不算未赋值参数）');
  const envLoaded = await api('/api/case/load', { file: fileParam });
  ok(envLoaded.title === 'e2e-env用例' && envLoaded.steps[0].prompt === '点击 ${{E2E_ENV}} 按钮',
    `\${{ENV}} 原样保留在 YAML（prompt =「${envLoaded.steps[0].prompt}」）`);
  ok(envLoaded.steps.length === 1,
    '仅剩环境变量占位符时不再重复展开（侧车里的 paramA=甲|乙 未被引用，steps 长度 1）');
  ok(!JSON.stringify(envLoaded.params || []).includes('E2E_ENV'), '${{ENV}} 不进入用例参数集合（.params.json 无 E2E_ENV）');
  const fileCountAfter = (await api('/api/cases')).groups.find((g) => g.group === GROUP).files.length;
  ok(fileCountAfter === fileCountBefore, `编辑已有用例后覆盖保存（文件数保持 ${fileCountAfter}，不产生重复文件）`);

  // ================================================================ 4) 结果栏按次隔离
  section('4) 结果栏按次隔离（resetFeed）：新执行首屏无旧记录');
  // 目标页切到本地 data: fixture → 缓存 xpath 可解析 → 后续 Tier 2 命中（零 AI）
  await api('/api/navigate', { url: TARGET_URL });
  ok((await api('/api/state')).url.startsWith('data:text/html'), 'POST /api/navigate 切到本地 data: 目标页（结构与缓存 xpath 对齐）');
  ok((await feedText()).includes('已保存'), '（前置）结果栏此刻仍残留上一节的保存回执');
  await page.fill(`${row(1)} .s-prompt`, '点击 ${paramC}');
  await page.click('#btn-run-case');
  await page.waitForFunction(() => document.querySelector('#feed')?.innerText.includes('${paramC}'), null, { timeout: 15000 });
  const feedC = await feedText();
  ok(!feedC.includes('已保存'), '第 1 次执行：结果栏已清空（旧保存回执消失，只剩本次记录）');
  ok(feedC.includes('参数未提供值') && feedC.includes('${paramC}'), '第 1 次执行只含本次错误记录');
  await page.fill(`${row(1)} .s-prompt`, '点击 ${paramD}');
  await page.click('#btn-run-case');
  await page.waitForFunction(() => document.querySelector('#feed')?.innerText.includes('${paramD}'), null, { timeout: 15000 });
  const feedD = await feedText();
  ok(!feedD.includes('paramC'), '第 2 次执行：结果栏不含第 1 次记录（paramC 痕迹已清）');
  ok(feedD.includes('${paramD}') && !feedD.includes('已保存'), '第 2 次执行只含本次记录');

  // 单步骤 ▶ 走 Tier 2 缓存命中：真实执行闭环，1~2s，零 AI 调用
  await page.selectOption(`${row(1)} .s-action`, 'input');
  await page.waitForFunction(() => document.querySelector('#steps .step:first-child .s-value')?.hidden === false);
  await page.fill(`${row(1)} .s-prompt`, CACHED_PROMPT);
  await page.fill(`${row(1)} .s-value`, 'e2e-tier2-value');
  await page.click(`${row(1)} .s-run`);
  await page.waitForFunction(() => document.querySelector('#btn-run-case')?.classList.contains('busy'), null, { timeout: 5000 });
  const busyState = await page.evaluate(() => {
    const b = document.querySelector('#btn-run-case');
    return { disabled: b.disabled, cursor: getComputedStyle(b).cursor, text: b.textContent.trim() };
  });
  ok(busyState.disabled === true && busyState.text === '执行中…', '执行期间「运行用例」置为「执行中…」且 disabled（setBusy）');
  ok(busyState.cursor === 'wait', `执行中（busy 态）cursor=wait（实测 ${busyState.cursor}），与 idle 禁用态 not-allowed 明确区分`);
  await page.waitForSelector('#feed .card.t2', { timeout: 40000 });
  ok((await page.locator('#feed .card.t2').first().innerText()).includes('Tier 2 · 缓存命中'), 'input 步骤命中定位缓存：卡片徽标「Tier 2 · 缓存命中」');
  ok((await page.locator('#feed .card.t2 .xpath-chip').first().innerText()).includes(CACHED_XPATH),
    `缓存命中卡片带解析出的 xpath（${CACHED_XPATH}）`);
  const feedT2 = await feedText();
  ok(!feedT2.includes('paramD') && !feedT2.includes('已保存'), '单步执行同样重置结果栏（不含上一次记录）');
  ok((await page.locator('#feed .card.err').count()) === 0, '本次真实执行无失败卡片（input 已按缓存 xpath 执行）');
  ok((await page.locator('#feed .card.t2 .prompt-line').first().innerText()).includes(CACHED_PROMPT), '结果卡片记录本次 prompt');

  // ================================================================ 5) 业务语义面板
  section('5) 业务语义面板：列表渲染、参数展示「参数: name」、▶ 弹参数框（demo2 只读，不写入）');
  // 面板首次渲染：有语义则渲染条目、无语义则渲染空态提示（两种都算「列表渲染完成」）
  const semAtStart = await page.locator('#sem-list .sem-item').count();
  ok(semAtStart > 0 || (await page.locator('#sem-list .empty').count()) === 1,
    `语义面板完成首次渲染（当前 ${semAtStart} 条语义 / 空态提示）`);
  // 用户数据只读断言：demo2 若存在，必须正常渲染出「参数: name」（本脚本不写它）
  if (demo2Baseline != null) {
    const demoMeta = (await page.locator('#sem-list .sem-item[data-name="demo2"] .sem-meta').innerText()).trim();
    ok(demoMeta.includes('参数: name'), `用户语义 demo2 正常渲染：「${demoMeta}」（含 参数: name，只读校验）`);
  } else {
    ok(true, '用户语义 demo2 不存在（跳过只读校验；本脚本不会创建它）');
  }
  // 用编辑器当前唯一一步，真实走「⚡ 存为语义」UI 流程生成临时语义（自建名，用后删除）
  await page.fill(`${row(1)} .s-prompt`, '在${name}输入框中输入');
  await page.fill(`${row(1)} .s-value`, '${name}');
  await page.fill('#case-title', SEM_TMP);
  const semTmpExisted = (await page.locator(`#sem-list .sem-item[data-name="${SEM_TMP}"]`).count()) > 0;
  const semBefore = await page.locator('#sem-list .sem-item').count();
  const dlgSem = await withDialog(async () => { await page.click('#btn-save-semantic'); }, { value: SEM_TMP, kind: 'prompt' });
  ok(dlgSem.type === 'prompt' && dlgSem.message.includes('业务语义名称') && dlgSem.defaultValue === SEM_TMP,
    `「⚡ 存为语义」弹出命名 prompt（默认值 = 用例标题 ${SEM_TMP}）`);
  await page.waitForSelector(`#sem-list .sem-item[data-name="${SEM_TMP}"]`, { timeout: 15000 });
  ok((await page.locator('#sem-list .sem-item').count()) === semBefore + (semTmpExisted ? 0 : 1),
    `语义面板渲染出 ${SEM_TMP} 条目（${semTmpExisted ? '同名覆盖，不产生重复' : '新增一条'}）`);
  const semMeta = (await page.locator(`#sem-list .sem-item[data-name="${SEM_TMP}"] .sem-meta`).innerText()).trim();
  ok(semMeta.includes('参数: name'), `临时语义形参展示「${semMeta}」（含 参数: name）`);
  ok((await page.locator(`#sem-list .sem-item[data-name="${SEM_TMP}"] .sem-name`).innerText()).includes(`⚡ ${SEM_TMP}`), `语义条目名称渲染 ⚡ ${SEM_TMP}`);
  ok(
    (await page.locator(`#steps .step:first-child .s-action optgroup[label="业务语义（组合步骤）"] option[value="sem:${SEM_TMP}"]`).count()) === 1,
    `步骤动作下拉同步出现「业务语义」分组与 ⚡ ${SEM_TMP} 选项`,
  );
  // ▶ 弹参数框（page.waitForEvent('dialog') 接管 prompt，取消后不得执行）
  const dlgRunSem = await withDialog(async () => {
    await page.click(`#sem-list .sem-item[data-name="${SEM_TMP}"] .sem-run`);
  }, { dismiss: true, kind: 'prompt' });
  ok(dlgRunSem.type === 'prompt' && dlgRunSem.message.includes('需要参数：name') && dlgRunSem.defaultValue === 'name=',
    `点击语义 ▶ 弹出参数框（「需要参数：name」，默认 name=）`);
  ok(!(await feedText()).includes('运行语义'), '取消参数框后不执行语义（runSemanticNow 提前 return，无执行记录）');

  // ${{ENV}} 不计入语义形参：清空 value 后改为 ${{ENV}} 步骤再存一条临时语义
  await page.fill(`${row(1)} .s-value`, '');
  await page.selectOption(`${row(1)} .s-action`, 'tap');
  await page.waitForFunction(() => document.querySelector('#steps .step:first-child .s-value')?.hidden === true);
  await page.fill(`${row(1)} .s-prompt`, '点击 ${{E2E_ENV}} 按钮');
  const envExisted = (await page.locator(`#sem-list .sem-item[data-name="${SEM_ENV}"]`).count()) > 0;
  const semBefore2 = await page.locator('#sem-list .sem-item').count();
  await withDialog(async () => { await page.click('#btn-save-semantic'); }, { value: SEM_ENV, kind: 'prompt' });
  await page.waitForSelector(`#sem-list .sem-item[data-name="${SEM_ENV}"]`, { timeout: 15000 });
  const envSemMeta = (await page.locator(`#sem-list .sem-item[data-name="${SEM_ENV}"] .sem-meta`).innerText()).trim();
  ok(envSemMeta.includes('无参数'), `\${{ENV}} 不计入语义形参（meta =「${envSemMeta}」）`);
  ok((await page.locator('#sem-list .sem-item').count()) === semBefore2 + (envExisted ? 0 : 1), `临时语义 ${SEM_ENV} 已渲染`);
  // 真实走 ✕ + confirm 删除两条临时语义（demo2 只读不动）
  const dlgSemDel = await withDialog(async () => {
    await page.click(`#sem-list .sem-item[data-name="${SEM_ENV}"] .sem-del`);
  }, { kind: 'confirm' });
  ok(dlgSemDel.type === 'confirm' && dlgSemDel.message.includes('删除业务语义'), '语义删除走 confirm 二次确认');
  await page.waitForFunction(
    (n) => document.querySelectorAll(`#sem-list .sem-item[data-name="${n}"]`).length === 0,
    SEM_ENV,
    { timeout: 15000 },
  );
  ok(true, `临时语义 ${SEM_ENV} 已从面板移除`);
  await withDialog(async () => {
    await page.click(`#sem-list .sem-item[data-name="${SEM_TMP}"] .sem-del`);
  }, { kind: 'confirm' });
  await page.waitForFunction(
    (n) => document.querySelectorAll(`#sem-list .sem-item[data-name="${n}"]`).length === 0,
    SEM_TMP,
    { timeout: 15000 },
  );
  ok(true, `临时语义 ${SEM_TMP} 已从面板移除`);
  ok(
    (await page.locator(`#sem-list .sem-item[data-name="${SEM_TMP}"], #sem-list .sem-item[data-name="${SEM_ENV}"]`).count()) === 0,
    '面板不残留任何 e2e-tmp-* 临时语义',
  );

  // ================================================================ 8) ✎ 编辑回填
  section('8) 用例库 ✎ 编辑：标题 / 步骤 / 参数回填到编辑器');
  await page.click(`.case-item[data-file="${f1}"] .ci-edit`);
  await page.waitForFunction(() => document.querySelector('#case-title')?.value === 'e2e-fixture', null, { timeout: 15000 });
  ok((await page.inputValue('#case-title')) === 'e2e-fixture', '标题回填为 e2e-fixture');
  ok((await page.inputValue('#case-group')) === GROUP, `分组回填为 ${GROUP}`);
  const lPrompts = await page.$$eval('#steps .step .s-prompt', (els) => els.map((e) => e.value));
  const lActions = await page.$$eval('#steps .step .s-action', (els) => els.map((e) => e.value));
  ok(lPrompts.length === 2 && lPrompts[0] === '点击待办输入框' && lPrompts[1] === '断言页面展示待办列表', '两步 prompt 逐一回填');
  ok(lActions.join(',') === 'tap,assert', `两步动作回填（${lActions.join(' / ')}）`);
  const pRows = await page.$$eval('#param-rows .param-row', (rows) => rows.map((r) => ({
    k: r.querySelector('.p-k').value, v: r.querySelector('.p-v').value,
  })));
  ok(pRows.length === 1 && pRows[0].k === 'name' && pRows[0].v === '张三', `参数行回填（${pRows.map((p) => `${p.k}=${p.v}`).join(', ')}）`);
  ok((await feedText()).includes('已加载用例到编辑器'), '结果栏出现「✎ 已加载用例到编辑器」回执');

  // ================================================================ 9) 右栏内部滚动
  section('9) 右侧分组过多时列表内部滚动（scrollHeight > clientHeight 且 scrollTop 可设）');
  const scrollM = await page.evaluate(() => {
    const list = document.querySelector('#case-groups');
    const groups = list.querySelectorAll('.case-group').length;
    list.scrollTop = 400;
    return {
      groups,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      scrollTop: list.scrollTop,
      overflowY: getComputedStyle(list).overflowY,
      bodyScrollHeight: document.body.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });
  ok(scrollM.groups === expectedGroups, `右侧渲染 ${scrollM.groups} 个分组（超出可视高度）`);
  ok(scrollM.scrollHeight > scrollM.clientHeight, `#case-groups 内部滚动（scrollHeight ${scrollM.scrollHeight} > clientHeight ${scrollM.clientHeight}）`);
  ok(scrollM.scrollTop > 0, `设置 scrollTop=400 后真实滚动（实测 scrollTop=${scrollM.scrollTop}）`);
  ok(scrollM.overflowY === 'auto' || scrollM.overflowY === 'scroll', `#case-groups overflow-y=${scrollM.overflowY}`);
  ok(scrollM.bodyScrollHeight <= scrollM.innerHeight + 1, `整页不溢出（body ${scrollM.bodyScrollHeight} <= 视口 ${scrollM.innerHeight}+1）`);

  // 收尾清理
  section('清理：删除 fixture、移除 e2e-tmp* 目录、结束进程树');
  const { removed, dirs } = await cleanupFixtures();
  const afterClean = await api('/api/cases');
  ok(!(afterClean.groups || []).some((g) => g.group.startsWith('e2e-tmp')), `删除 ${removed.length} 个 fixture 文件后 /api/cases 无 e2e-tmp* 分组`);
  ok(dirs.every((d) => !existsSync(join(CASES_DIR, d))), `移除 ${dirs.length} 个 e2e-tmp* 空目录（${dirs.join(' / ')}）`);
  // 既有 cases/ 子目录（用户 demo 目录等）必须保持原样：清理前后集合相同
  const postDirs = (await readdir(CASES_DIR).catch(() => [])).filter((n) => !n.startsWith('e2e-tmp')).sort();
  ok(
    JSON.stringify(postDirs) === JSON.stringify(preDirs),
    `未改动既有 cases/ 子目录（运行前 ${preDirs.length} 个 → 运行后 ${postDirs.length} 个：${postDirs.join(' / ') || '空'}）`,
  );
  const semFiles = await readdir(SEM_DIR).catch(() => []);
  ok(!semFiles.some((f) => f.startsWith('e2e-tmp')), `临时语义文件已清理（语义目录现有：${semFiles.join(', ') || '空'}）`);
  const demo2Now = existsSync(DEMO2_FILE) ? await readFile(DEMO2_FILE, 'utf8') : null;
  ok(demo2Now === demo2Baseline, 'console/semantics/demo2.json（用户数据）运行前后逐字节一致，未被本脚本改写');

  await browser.close();
  browser = null;
  console.log('  · Playwright 浏览器已关闭');
} catch (err) {
  console.error(`\n✕ E2E 失败：${err?.stack || err}`);
  if (serverOutput.trim()) console.error(`--- 服务进程输出 ---\n${serverOutput.trim().split('\n').slice(-20).join('\n')}`);
  process.exitCode = 1;
} finally {
  // ---- 进程与 fixture 兜底清理（失败路径也要保证不留残留） ----
  try { await browser?.close(); } catch { /* 已关闭 */ }
  // 只在「本脚本自己的服务实例」上清理：端口被别人占用时提前失败，绝不能去动别人的用例库
  if (server && await isReachable()) {
    try {
      const { removed, dirs } = await cleanupFixtures();
      if (removed.length) console.log(`  · 兜底清理：删除 ${removed.length} 个 fixture、移除 ${dirs.length} 个 e2e-tmp* 目录`);
    } catch { /* best-effort */ }
  }
  const killed = killServer();
  if (killed) {
    const deadline = Date.now() + 8000;
    let freed = false;
    while (Date.now() < deadline) {
      if (!(await isReachable())) { freed = true; break; }
      await sleep(300);
    }
    console.log(`  · taskkill /T 结束服务进程树；端口 ${PORT} ${freed ? '已释放' : '仍被占用（请检查残留）'}`);
  }
  // 定位缓存：既有缓存命中不写盘；seed 出来的最小 fixture 用后删除
  if (cacheSeeded) {
    await unlink(CACHE_FILE).catch(() => {});
    console.log('  · 已删除本次运行自建的缓存 seed fixture（恢复「无缓存」的干净状态）');
  } else if (cacheBaseline != null) {
    const now = await readFile(CACHE_FILE, 'utf8').catch(() => null);
    if (now === cacheBaseline) console.log('  · 共享定位缓存文件未被本次运行改动（Tier 2 命中不写盘）');
    else if (now != null && now.startsWith(cacheBaseline)) {
      await writeFile(CACHE_FILE, cacheBaseline, 'utf8').catch(() => {});
      console.log(`  · 共享定位缓存被追加了 ${now.length - cacheBaseline.length} 字符（本次新定位回填）→ 已按运行前快照还原`);
    } else {
      console.log('  · 共享定位缓存被其它实例改写（非本次纯追加）→ 未还原，避免误删他人记录');
    }
  }
  // 用户数据只读兜底：若被意外改写，按运行前快照还原并告警
  const demo2After = existsSync(DEMO2_FILE) ? await readFile(DEMO2_FILE, 'utf8') : null;
  if (demo2After !== demo2Baseline) {
    if (demo2Baseline != null) await writeFile(DEMO2_FILE, demo2Baseline, 'utf8').catch(() => {});
    console.log('  · ⚠ demo2.json（用户数据）被意外改动 → 已按运行前快照还原');
  }
}

// ---------------------------------------------------------------- 汇总
const spent = ((Date.now() - startedAt) / 1000).toFixed(1);
if (process.exitCode) {
  console.error(`\nE2E 未通过：已 PASS ${passList.length} 项断言后中断（用时 ${spent}s）`);
} else {
  console.log(`\n${'='.repeat(76)}`);
  console.log(`E2E 全流程通过：${passList.length} 项断言全部 PASS（用时 ${spent}s，端口 ${PORT}）`);
  console.log('逐项 PASS 列表：');
  passList.forEach((label, i) => console.log(`  ${String(i + 1).padStart(2, '0')} ✓ ${label}`));
}
