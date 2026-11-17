/**
 * 定位控制台 — 后端服务（零新增依赖：node:http + 工程现有 @midscene/web + playwright）
 *
 * 架构：浏览器前端 → 本服务 → PlaywrightAgent(page, { cache }) → Midscene 三层链路
 *       （Tier1 显式 xpath → Tier2 定位缓存 → Tier3 AI 视觉，全部在后台自动完成）
 *
 * 分层探测（对用户透明展示）：
 *   - 请求带 xpath            → Tier 1-explicit（并验证解析结果）
 *   - 执行前后缓存 diff：
 *       无记录→有记录          → Tier 3-ai（AI 定位 + 自动回填）
 *       有记录且未变化          → Tier 2-cache（缓存命中）
 *       有记录且变化/新增       → Tier 3-ai（缓存失效回退 AI + 回填）
 *
 * 运行：pnpm console   （必须从项目根启动，缓存文件与 YAML 用例共享）
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, unlink, writeFile, readdir } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

// Windows 传统控制台默认代码页可能不是 UTF-8，切到 65001 保证中文提示不乱码
if (process.platform === 'win32') {
  try { execSync('chcp 65001', { stdio: 'ignore' }); } catch { /* 忽略 */ }
}
import { config as loadEnv } from 'dotenv';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright/agent';
import {
  yamlScalar, parseCache, parseCaseYaml, buildCaseYaml,
  recordsForPrompt, snapshotOf,
  LOCATING_ACTIONS, SEMANTIC_LABEL, ACTION_NODES, NODE_TO_ACTION,
} from './lib.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnv({ path: join(ROOT, '.env') });

const PORT = Number(process.env.CONSOLE_PORT || 23366);
const CACHE_ID = 'web-locate-chain';
const CACHE_FILE = join(ROOT, 'midscene_run', 'cache', `${CACHE_ID}.cache.yaml`);
const PUBLIC_DIR = join(ROOT, 'console', 'public');
const DEFAULT_URL =
  process.env.CONSOLE_HOME_URL || 'https://todomvc.com/examples/react/dist/#/';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- browser
// 浏览器模式（每次启动交互选择；非 TTY 环境按 env 优先级静默决定）：
//   1) cdp        CDP 接管真实 Chrome —— 复用其全部已登录 token/cookie
//                 （需先用 console\start-chrome-debug.ps1 启动调试 Chrome）
//   2) persistent 持久化登录态 profile —— 首次登录一次，长期复用
//   3) fresh      全新无痕上下文
// env 非交互默认：CONSOLE_CDP_URL → cdp；CONSOLE_USER_DATA_DIR → persistent。
// 上次选择存于 midscene_run/browser-mode.json，作为菜单默认项。
import { createInterface } from 'node:readline/promises';

const CDP_URL = process.env.CONSOLE_CDP_URL || 'http://127.0.0.1:9222';
const PROFILE_DIR = process.env.CONSOLE_USER_DATA_DIR || join(process.env.LOCALAPPDATA || tmpdir(), 'LocateConsoleProfile');
const HEADLESS = process.env.HEADLESS !== 'false';
const MODE_FILE = join(ROOT, 'midscene_run', 'browser-mode.json');

function readLastMode() {
  try { return JSON.parse(readFileSync(MODE_FILE, 'utf8')).mode ?? null; }
  catch { return null; }
}
function writeLastMode(mode) {
  try { mkdirSync(dirname(MODE_FILE), { recursive: true }); writeFileSync(MODE_FILE, JSON.stringify({ mode })); }
  catch { /* best-effort */ }
}

// ---- 方式1 全链自动化：CDP 模式自动拉起调试 Chrome（若未运行）+ 成功后自动打开前端 ----
const DEBUG_PROFILE = join(process.env.LOCALAPPDATA || tmpdir(), 'ChromeDebugProfile');
const FRONTEND_URL = `http://127.0.0.1:${PORT}`;

function findChromePath() {
  const appPaths = join(process.env.WINDIR || 'C:\\Windows', 'System32');
  const candidates = [
    process.env.CONSOLE_CHROME_PATH,
    join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

async function cdpAlive(port = 9222, ms = 2000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch {}
    await new Promise((res) => setTimeout(res, 400));
  }
  return false;
}

async function ensureDebugChrome() {
  if (await cdpAlive()) { console.log('[i] 已检测到调试版 Chrome 正在运行（端口 9222），直接复用'); return; }
  const chromePath = process.env.CONSOLE_CHROME_PATH || findChromePath();
  if (!chromePath) throw new Error('未找到 chrome.exe，请在 .env 中设置 CONSOLE_CHROME_PATH 指向 Chrome 安装路径');
  console.log(`[i] 未检测到调试版 Chrome（端口 9222），正在为你启动：${chromePath}`);
  mkdirSync(DEBUG_PROFILE, { recursive: true });
  const child = spawn(chromePath, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${DEBUG_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
  ], { detached: true, stdio: 'ignore' });
  child.unref(); // 调试 Chrome 独立于服务生命周期
  const ready = await cdpAlive(9222, 20000);
  if (!ready) throw new Error('调试版 Chrome 启动后 20 秒内未开放 9222 端口（Chrome 136+ 会忽略默认配置的调试端口，请使用本程序自动创建的独立调试档案，或先运行 console\\start-chrome-debug.ps1）');
  console.log('[i] 调试版 Chrome 已就绪（端口 9222）');
}

function openFrontend() {
  try {
    spawn('cmd', ['/c', 'start', '', FRONTEND_URL], { detached: true, stdio: 'ignore' }).unref();
    console.log(`[i] 已为你打开操作界面：${FRONTEND_URL}`);
  } catch { /* best-effort */ }
}

function pickNonInteractiveMode() {
  // 非交互（CI/脚本/重定向）：沿用上次交互选择；首次使用为全新无痕。
  // env 的 CONSOLE_CDP_URL / CONSOLE_USER_DATA_DIR 仅提供对应模式的参数，
  // 不再充当模式选择器（避免 .env 残留配置锁死启动模式）。
  return readLastMode() ?? 'fresh';
}

const MODES = {
  cdp: '接管你正在使用的 Chrome（自动复用全部已登录状态；首次会自动启动调试版 Chrome）',
  persistent: `使用独立的登录档案（${PROFILE_DIR}；登录一次，以后自动复用）`,
  fresh: '全新无痕环境（不保留任何登录状态）',
};

// 交互判定统一入口：真 TTY，或显式 CONSOLE_INTERACTIVE=1（测试/重定向场景）
const INTERACTIVE = process.stdin.isTTY === true || process.env.CONSOLE_INTERACTIVE === '1';

async function askBrowserMode() {
  if (!INTERACTIVE) return pickNonInteractiveMode();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const keys = Object.keys(MODES); // ['cdp','persistent','fresh']
    const defaultMode = keys.includes(readLastMode()) ? readLastMode() : 'fresh';
    const defaultKey = keys.includes(defaultMode) ? defaultMode : 'fresh';
    console.log('\n[?] 请选择浏览器模式（直接按回车 = 使用默认项）：');
    keys.forEach((k, i) => {
      const mark = k === defaultKey ? ' [默认]' : '';
      console.log(`  ${i + 1}) ${k.padEnd(10)} ${MODES[k]}${mark}`);
    });
    for (;;) {
      const ans = (await rl.question('  请输入 1 / 2 / 3 后按回车：')).trim();
      if (ans === '') return defaultKey;
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= keys.length) return keys[n - 1];
      console.log('  输入无效，请重新输入 1、2、3，或直接按回车使用默认项。');
    }
  } finally {
    rl.close();
  }
}

let browser = null;
let context = null;
let page = null;

async function initBrowser(mode) {
  if (mode === 'cdp') {
    await ensureDebugChrome(); // 方式1 全链：9222 未运行时自动拉起调试 Chrome
    console.log(`[i] 正在连接浏览器（最多等待 15 秒）：${CDP_URL}`);
    browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    context = browser.contexts()[0] ?? (await browser.newContext({ viewport: { width: 1280, height: 760 } }));
    page = context.pages()[0] ?? (await context.newPage());
    console.log(`[locate-console] 浏览器模式：接管 Chrome ${CDP_URL}（共 ${context.pages().length} 个标签页：${context.pages().map((p) => p.url()).join(' | ')}）`);
  } else if (mode === 'persistent') {
    console.log(`[i] 正在启动独立登录档案：${PROFILE_DIR}`);
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: HEADLESS,
      viewport: { width: 1280, height: 760 },
    });
    page = context.pages()[0] ?? (await context.newPage());
    console.log(`[locate-console] 浏览器模式：独立登录档案 ${PROFILE_DIR}`);
  } else {
    browser = await chromium.launch({ headless: HEADLESS });
    context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
    page = await context.newPage();
    console.log('[locate-console] 浏览器模式：全新无痕环境');
  }
  writeLastMode(mode);
}

// 启动循环：CDP 不可达等失败 → 提示后回菜单重选（而非直接退出）
while (true) {
  const mode = await askBrowserMode();
  try {
    await initBrowser(mode);
    break;
  } catch (err) {
    console.error(`[locate-console] 浏览器启动失败（模式：${mode}）：${err.message.split('\n')[0]}`);
    if (!INTERACTIVE) {
      console.error('  当前为非交互方式运行，无法重新选择，已退出。（请检查 .env 中的 CONSOLE_CDP_URL，或先运行 console\\start-chrome-debug.ps1）');
      process.exit(1);
    }
    console.error('  → 请在下方重新选择一种模式。\n');
  }
}

// 启动成功后自动打开项目前端（交互模式；CDP 模式即方式1 全链的收尾）
if (INTERACTIVE) openFrontend();

// 定位缓存开关：默认启用；MIDSCENE_LOCATE_CACHE=false 可临时关闭（关闭后每次都要走 AI）
const LOCATE_CACHE_ENABLED = process.env.MIDSCENE_LOCATE_CACHE !== 'false';

let agent = null;
function getAgent() {
  agent ??= new PlaywrightAgent(page, { cache: LOCATE_CACHE_ENABLED ? { id: CACHE_ID } : false });
  return agent;
}
async function resetAgent() {
  try { await agent?.destroy(); } catch { /* already gone */ }
  agent = null;
}

// ---------------------------------------------------------------- cache io
async function readCacheRecords() {
  try { return parseCache(await readFile(CACHE_FILE, 'utf8')); }
  catch { return []; }
}

/** 在当前页面验证 xpath 可解析且有 rect（展示用；Midscene 内部有同等校验） */
async function evalXpath(xpath) {
  try {
    return await page.evaluate((xp) => {
      const node = document.evaluate(
        xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      ).singleNodeValue;
      if (!(node instanceof Element)) return { ok: false };
      const rect = node.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      return { ok: visible, rect: visible ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height } : null };
    }, xpath);
  } catch { return { ok: false }; }
}

async function firstValidXpath(records, prompt) {
  for (const record of recordsForPrompt(records, prompt)) {
    for (const xpath of record.xpaths) {
      const result = await evalXpath(xpath);
      if (result.ok) return { xpath, rect: result.rect };
    }
  }
  return null;
}

// ---------------------------------------------------------------- actions
async function runAction(body) {
  const prompt = String(body.prompt || '').trim();
  const action = String(body.action || 'tap');
  // 整页动作（按键/滚动）允许不带目标定位，prompt 合法为空
  const PAGE_LEVEL_ACTIONS = new Set(['keyboardPress', 'scroll']);
  if (!prompt && !PAGE_LEVEL_ACTIONS.has(action)) {
    throw new Error('缺少自然语言指令（prompt）');
  }
  const userXpath = typeof body.xpath === 'string' && body.xpath.trim() ? body.xpath.trim() : null;
  const value = body.value;

  const agent = getAgent();
  const before = snapshotOf(await readCacheRecords(), prompt);
  const startedAt = Date.now();

  const locateOpt = userXpath ? { xpath: userXpath } : {};
  let tier;
  let note = '';
  let result;

  if (userXpath) {
    const probe = await evalXpath(userXpath);
    tier = '1-explicit';
    note = probe.ok
      ? `显式 xpath 当前解析成功（rect ${Math.round(probe.rect.w)}×${Math.round(probe.rect.h)} @ ${Math.round(probe.rect.x)},${Math.round(probe.rect.y)}）`
      : '显式 xpath 当前解析失败/无可见 rect，Midscene 将自动降级到缓存或 AI';
  }

  switch (action) {
    case 'tap': await agent.aiTap(prompt, locateOpt); break;
    case 'doubleClick': await agent.aiDoubleClick(prompt, locateOpt); break;
    case 'middleClick': await agent.aiMiddleClick(prompt, locateOpt); break;
    case 'rightClick': await agent.aiRightClick(prompt, locateOpt); break;
    case 'hover': await agent.aiHover(prompt, locateOpt); break;
    case 'longPress': await agent.aiLongPress(prompt, locateOpt); break;
    case 'input': {
      if (value === undefined || value === null || String(value) === '') {
        throw new Error('输入动作需要 value（要输入的内容）');
      }
      await agent.aiInput(prompt, { ...locateOpt, value: String(value) });
      break;
    }
    case 'clearInput': await agent.aiClearInput(prompt, locateOpt); break;
    case 'keyboardPress': {
      if (!value) throw new Error('按键动作需要 value（按键名，如 Enter）');
      await agent.aiKeyboardPress(prompt || undefined, { ...locateOpt, keyName: String(value) });
      break;
    }
    case 'scroll': {
      if (!value) throw new Error('滚动动作需要 value（方向，可带距离，如 "down 600"）');
      const parts = String(value).trim().split(/\s+/);
      const direction = parts[0];
      if (!['down', 'up', 'left', 'right'].includes(direction)) {
        throw new Error(`滚动方向无效：${direction}（可用 down / up / left / right）`);
      }
      const distance = parts[1] ? Number(parts[1]) : undefined;
      const param = { ...locateOpt, direction };
      if (Number.isFinite(distance) && distance > 0) param.distance = distance;
      await agent.aiScroll(prompt || undefined, param);
      break;
    }
    case 'locate': {
      const el = await agent.aiLocate(prompt, locateOpt);
      result = el ? { center: el.center, dpr: el.dpr } : null;
      break;
    }
    case 'act': {
      result = (await agent.aiAct(prompt)) ?? null;
      break;
    }
    case 'assert': await agent.aiAssert(prompt); break;
    case 'waitFor': await agent.aiWaitFor(prompt); break;
    case 'boolean': result = await agent.aiBoolean(prompt); break;
    case 'query': result = await agent.aiQuery(prompt); break;
    case 'number': result = await agent.aiNumber(prompt); break;
    case 'string': result = await agent.aiString(prompt); break;
    case 'ask': result = await agent.aiAsk(prompt); break;
    default:
      throw new Error(`未知动作：${action}（可选 ${Object.keys(ACTION_NODES).join(' / ')}）`);
  }

  const ms = Date.now() - startedAt;
  const afterRecords = await readCacheRecords();
  const after = snapshotOf(afterRecords, prompt);

  // 分层判定（仅带定位语义的 prompt 参与；显式 xpath 已定 Tier 1）
  const isLocating = LOCATING_ACTIONS.has(action) && !!prompt;
  if (!userXpath) {
    if (!isLocating) {
      tier = 'ai-semantic';
      note = `${SEMANTIC_LABEL[action] || action}：纯语义调用（无元素定位，不涉及缓存）`;
    } else if (before === '[]' && after !== '[]') {
      tier = '3-ai';
      note = '首次定位：AI 视觉完成，结果已自动回填缓存（下次运行免 AI）';
    } else if (before !== '[]' && before === after) {
      tier = '2-cache';
      note = '缓存命中：缓存 xpath 重解析校验通过，零 AI 调用';
    } else if (before !== '[]' && before !== after) {
      tier = '3-ai';
      note = '缓存失效（重解析被拒绝）→ 自动回退 AI → 新 xpath 已回填缓存';
    } else {
      tier = '3-ai';
      note = 'AI 视觉定位完成';
    }
  }

  const used = userXpath
    ? { xpath: userXpath, rect: null }
    : (isLocating ? await firstValidXpath(afterRecords, prompt) : null);

  // 关键体验补丁：AI 回填落盘后重建 agent。
  // Midscene 的 matchCache 只扫描 agent 构造时从文件加载的原始记录段，
  // 运行中新回填的记录不参与匹配；重建后下次同 prompt 立即 Tier 2 命中，
  // 用户只需再说一遍同样的话（“说一遍就记住”）。
  if (!userXpath && before !== after) {
    await resetAgent();
  }

  const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
  return {
    ok: true,
    action,
    prompt,
    tier,
    note,
    ms,
    result: result ?? null,
    xpath: used?.xpath ?? null,
    cacheCount: afterRecords.length,
    url: page.url(),
    screenshot: `data:image/jpeg;base64,${screenshot.toString('base64')}`,
  };
}

// ---------------------------------------------------------------- 用例 YAML 保存
async function saveCaseYaml(body) {
  const title = String(body.title || '').trim() || '未命名用例';
  const group = String(body.group || '').trim().replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+$/, '');
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!steps.length) throw new Error('用例至少需要一个步骤');
  for (const [i, s] of steps.entries()) {
    if (!ACTION_NODES[s.action]) throw new Error(`步骤 ${i + 1}：未知动作 ${s.action}`);
    if (!String(s.prompt || '').trim() && !['keyboardPress', 'scroll'].includes(s.action)) {
      throw new Error(`步骤 ${i + 1}：缺少自然语言描述（prompt）`);
    }
    if (s.action === 'input' && !String(s.value || '').trim()) {
      throw new Error(`步骤 ${i + 1}：输入动作需要 value`);
    }
    if (s.action === 'keyboardPress' && !String(s.value || '').trim()) {
      throw new Error(`步骤 ${i + 1}：按键动作需要 value（按键名）`);
    }
  }
  const slug = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'case';
  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '').replace(/-/g, '');
  const dir = group ? join(ROOT, 'cases', group) : join(ROOT, 'cases');
  await mkdir(dir, { recursive: true });
  // Overwrite an existing case file (edit-and-save flow) or create a new one
  const file = body.file ? safeCasePath(body.file).full : join(dir, `console-${slug}-${ts}.yaml`);
  // 记录保存时的页面 URL（beforeEach gotoUrl）——用例自包含，回归与 pnpm test 均自动导航
  const pageUrl = /^https?:\/\//.test(page.url() || '') ? page.url() : '';
  await writeFile(file, buildCaseYaml({ title, steps, url: pageUrl }), 'utf8');
  // 参数 sidecar：参数值随用例持久化（*.params.json 不被 pnpm test 的 *.yaml 收集）
  if (Array.isArray(body.params) && body.params.length) {
    await writeFile(file + '.params.json', JSON.stringify(body.params, null, 2), 'utf8');
  } else {
    // 参数被清空后覆盖保存时必须删除旧 sidecar，否则 /api/case/load 会把已删除的参数读回
    await unlink(file + '.params.json').catch(() => {});
  }
  return { file: file.slice(ROOT.length).split(sep).join('/').replace(/^\//, ''), dir: group || '' };
}

// ---------------------------------------------------------------- 用例库（分组 = cases/ 子目录）
const CASES_DIR = join(ROOT, 'cases');

async function listCases() {
  const groups = new Map();
  async function walk(dir, rel) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), childRel);
      else if (/\.(ya?ml)$/i.test(entry.name)) {
        let parsed = [];
        try { parsed = parseCaseYaml(await readFile(join(dir, entry.name), 'utf8')); } catch { /* skip */ }
        const group = rel || '';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({
          file: `cases/${childRel}`,
          group,
          cases: parsed.map((c) => ({ name: c.name, steps: c.steps.length, actions: c.steps.map((s) => s.action) })),
        });
      }
    }
  }
  await walk(CASES_DIR, '');
  return [...groups.entries()].map(([group, files]) => ({ group, files }))
    .sort((a, b) => (a.group === '' ? -1 : b.group === '' ? 1 : a.group.localeCompare(b.group)));
}

// ---------------------------------------------------------------- 业务语义库（组合步骤复用）
const SEMANTICS_DIR = join(ROOT, 'console', 'semantics');

function semanticSlug(name) {
  return String(name).trim().replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'semantic';
}

async function listSemantics() {
  const items = [];
  let files = [];
  try { files = await readdir(SEMANTICS_DIR); } catch { return items; }
  for (const f of files.filter((x) => x.endsWith('.json')).sort()) {
    try {
      const data = JSON.parse(await readFile(join(SEMANTICS_DIR, f), 'utf8'));
      if (data && data.name && Array.isArray(data.steps)) {
        // 官方语法 ${name}（兼容旧 {{name}}）；${{ENV}} 是环境变量，不计入形参
        const envRe = /\$\{\{\s*([^}]+?)\s*\}\}/g;
        const paramRe = /\$\{\s*([^}${]+?)\s*\}|\{\{\s*([^}${]+?)\s*\}\}/g;
        const paramNames = [...new Set(data.steps.flatMap((s) =>
          [s.prompt, s.xpath, s.value].flatMap((f) =>
            [...String(f ?? '').replace(envRe, '').matchAll(paramRe)].map((m) => String(m[1] ?? m[2] ?? '').trim()).filter(Boolean)
          )
        ))];
        items.push({ name: data.name, file: f, steps: data.steps, paramNames });
      }
    } catch { /* 跳过损坏文件 */ }
  }
  return items;
}

async function saveSemantic(body) {
  const name = String(body.name || '').trim();
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (!name) throw new Error('语义名称不能为空');
  if (!steps.length) throw new Error('语义至少包含一个步骤');
  for (const [i, s] of steps.entries()) {
    // sem: 前缀先判：它不是 ACTION_NODES 的成员，若先判未知动作则这条友好提示永远不可达
    if (String(s.action).startsWith('sem:')) throw new Error('语义不支持嵌套引用其他语义');
    if (!ACTION_NODES[s.action]) throw new Error(`步骤 ${i + 1}：未知动作 ${s.action}`);
  }
  const file = `${semanticSlug(name)}.json`;
  await mkdir(SEMANTICS_DIR, { recursive: true });
  await writeFile(join(SEMANTICS_DIR, file), JSON.stringify({ name, steps }, null, 2), 'utf8');
  return { file: `console/semantics/${file}`, name };
}

async function deleteSemantic(name) {
  const file = `${semanticSlug(name)}.json`;
  await unlink(join(SEMANTICS_DIR, file));
  return { ok: true };
}

function safeCasePath(file) {
  const rel = String(file || '').replace(/\\/g, '/');
  const full = resolve(join(CASES_DIR, rel.replace(/^cases\//, '')));
  // 边界必须带路径分隔符：否则 ../cases-evil/x.yaml 这类同前缀兄弟目录可绕过 startsWith
  const base = CASES_DIR.endsWith(sep) ? CASES_DIR : CASES_DIR + sep;
  if (full !== CASES_DIR && !full.startsWith(base)) throw new Error(`非法用例路径：${file}`);
  return { rel, full };
}

// ---------------------------------------------------------------- 批量回归
async function runCaseFiles(body) {
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new Error('未选择要运行的用例');
  const results = [];

  for (const file of files) {
    const { rel, full } = safeCasePath(file);
    let cases;
    try { cases = parseCaseYaml(await readFile(full, 'utf8')); }
    catch (err) {
      results.push({ file: rel, name: rel, passed: false, error: `解析失败：${err.message}`, steps: [] });
      continue;
    }
    if (!cases.length) {
      results.push({ file: rel, name: rel, passed: false, error: '未解析到用例（仅支持控制台生成的格式）', steps: [] });
      continue;
    }

    for (const c of cases) {
      await resetAgent(); // 每用例重建 agent：加载最新缓存 + 干净状态
      if (c.url) {
        try { await page.goto(c.url, { waitUntil: 'domcontentloaded', timeout: 45000 }); }
        catch (err) { /* 导航失败不阻断，让步骤自然暴露问题 */ }
      }
      const stepResults = [];
      const startedAt = Date.now();
      let passed = true;
      let lastShot = null;

      for (const [i, step] of c.steps.entries()) {
        try {
          const r = await runAction(step);
          lastShot = r.screenshot;
          stepResults.push({
            no: i + 1, action: step.action, prompt: step.prompt,
            ok: true, tier: r.tier, ms: r.ms, xpath: r.xpath ?? null, result: r.result ?? null,
          });
        } catch (err) {
          passed = false;
          stepResults.push({
            no: i + 1, action: step.action, prompt: step.prompt,
            ok: false, error: String(err?.message || err).slice(0, 300),
          });
          break; // bail：单用例失败即停
        }
      }
      results.push({
        file: rel, name: c.name, passed,
        ms: Date.now() - startedAt,
        steps: stepResults,
        screenshot: lastShot,
        total: c.steps.length, executed: stepResults.length,
      });
    }
  }

  return {
    ok: true,
    total: results.length,
    passedCount: results.filter((r) => r.passed).length,
    results,
  };
}

// ---------------------------------------------------------------- http
function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw new Error('请求体不是合法 JSON'); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    // ---- API ----
    if (url.pathname === '/api/state') {
      const records = await readCacheRecords();
      const shot = await page.screenshot({ type: 'jpeg', quality: 65 }).catch(() => null);
      return send(res, 200, {
        url: page.url(),
        title: await page.title().catch(() => ''),
        agentReady: !!agent,
        model: process.env.MIDSCENE_MODEL_NAME || '',
        cacheFile: CACHE_FILE,
        cache: records,
        screenshot: shot ? `data:image/jpeg;base64,${shot.toString('base64')}` : null,
      });
    }
    if (url.pathname === '/api/navigate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) throw new Error('缺少 url');
      await resetAgent();
      await page.goto(body.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      return send(res, 200, { ok: true, url: page.url(), title: await page.title().catch(() => '') });
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await runAction(body));
    }
    if (url.pathname === '/api/case/save' && req.method === 'POST') {
      const body = await readBody(req);
      const saved = await saveCaseYaml(body);
      return send(res, 200, { ok: true, ...saved });
    }
    if (url.pathname === '/api/cases' && req.method === 'GET') {
      return send(res, 200, { ok: true, groups: await listCases() });
    }
    if (url.pathname === '/api/case/delete' && req.method === 'POST') {
      const body = await readBody(req);
      const { full } = safeCasePath(body.file);
      await unlink(full);
      await unlink(full + '.params.json').catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/case/load' && req.method === 'POST') {
      const body = await readBody(req);
      const { full } = safeCasePath(body.file);
      const cases = parseCaseYaml(await readFile(full, 'utf8'));
      if (!cases.length) throw new Error('未解析到用例步骤');
      let params = [];
      try { params = JSON.parse(await readFile(full + '.params.json', 'utf8')); } catch {}
      return send(res, 200, {
        ok: true,
        title: cases[0].name,
        url: cases[0].url ?? '',
        steps: cases[0].steps,
        params: Array.isArray(params) ? params : [],
      });
    }
    if (url.pathname === '/api/case/run' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await runCaseFiles(body));
    }
    if (url.pathname === '/api/semantics' && req.method === 'GET') {
      return send(res, 200, { ok: true, semantics: await listSemantics() });
    }
    if (url.pathname === '/api/semantic/save' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await saveSemantic(body));
    }
    if (url.pathname === '/api/semantic/delete' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await deleteSemantic(String(body.name || '')));
    }
    if (url.pathname === '/api/agent/reset' && req.method === 'POST') {
      await resetAgent();
      return send(res, 200, { ok: true });
    }    if (url.pathname === '/api/cache/clear' && req.method === 'POST') {
      await unlink(CACHE_FILE).catch(() => {});
      await resetAgent();
      return send(res, 200, { ok: true, cache: [] });
    }

    // ---- 静态文件 ----
    let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !(await stat(file)).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache', // 前端迭代频繁：禁强缓存，杜绝"改了没生效"
    });
    res.end(await readFile(file));
  } catch (err) {
    send(res, 500, { ok: false, error: String(err?.message || err).slice(0, 600) });
  }
});

// 重复启动友好处理：端口被占时，若占用者是本服务实例 → 自动打开前端并退出（exit 0）；
// 否则提示换端口/释放端口（exit 1）。避免裸 EADDRINUSE 堆栈。
async function handlePortBusy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/state`);
    if (r.ok) {
      const s = await r.json();
      console.log(`[locate-console] 服务已在运行：http://127.0.0.1:${PORT}（模型 ${s.model}），本次直接打开操作界面，不再重复启动。`);
      spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${PORT}`], { detached: true, stdio: 'ignore' });
      return true;
    }
  } catch { /* 占用者不是本服务 */ }
  console.error(`[locate-console] 端口 ${PORT} 已被其他程序占用，请先关闭占用它的程序，或在 .env 中通过 CONSOLE_PORT 指定其他端口。`);
  return false;
}

server.on('error', (err) => {
  if (err?.code === 'EADDRINUSE') {
    handlePortBusy().then((friendly) => process.exit(friendly ? 0 : 1));
  } else {
    console.error(`[locate-console] 服务运行异常：${err?.message ?? err}`);
    process.exit(1);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[locate-console] 服务已就绪：http://127.0.0.1:${PORT}    定位缓存=${CACHE_ID}    模型=${process.env.MIDSCENE_MODEL_NAME || '(未设置)'}`);
  console.log('[i] 请在浏览器中打开上面的地址开始调试（按 Ctrl+C 可停止服务）');
  if (!LOCATE_CACHE_ENABLED) console.log('[i] 注意：定位缓存已关闭（MIDSCENE_LOCATE_CACHE=false），每次定位都会调用 AI 模型');
});

async function shutdown() {
  try { await resetAgent(); } catch {}
  try {
    if (CDP_URL) {
      // 接管模式：只断开 CDP 连接，绝不关闭用户的真实浏览器
      await browser?.close();
    } else {
      await context?.close(); // persistent / fresh：关闭浏览器实例
      if (browser) await browser.close();
    }
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
