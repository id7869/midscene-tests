/**
 * console 集成测试：独立服务实例（端口 23367）的全端点契约验证
 * 运行（项目根）：node --test console/test/integration.test.mjs
 *
 * 覆盖端点（server.mjs 路由全集）：
 *   GET  /api/state            状态字段 + 缓存文件指向
 *   POST /api/navigate         缺 url 报错 / 本地前端页导航
 *   POST /api/run              校验错误路径（缺 prompt / 缺 value / 方向非法 / 未知动作）
 *   POST /api/case/save        5 类校验 + 正常保存（含 params sidecar）
 *   GET  /api/cases            分组/文件/用例元数据结构
 *   POST /api/case/load        回读 title/url/steps/params（含 sidecar 清空闭环）
 *   POST /api/case/delete      删除 yaml + sidecar；列表移除
 *   POST /api/case/run         文件选择/解析错误路径（0 步用例不触发 AI）
 *   GET  /api/semantics        列表 + paramNames 识别（${name} ✓，${{ENV}} 排除 ✓，{{旧}} 兼容）
 *   POST /api/semantic/save    4 类校验 + 正常保存
 *   POST /api/semantic/delete  删除 + 列表移除 + 不存在报错
 *   POST /api/agent/reset      返回 ok 且 agentReady 回落
 *   GET  /api/cache/clear      方法门控（非 POST → 404）；POST 契约仅在 23366 无运行实例时执行
 *   静态资源                  / 、/app.js、/style.css、404、编码穿越防护
 *
 * 安全约束（与任务契约一致）：
 *   - 用例只用「校验错误路径 / 文件类端点」，绝不发起会触发 AI 定位的调用，也不写定位缓存。
 *   - /api/cache/clear 会删除 midscene_run/cache/*.cache.yaml（与 23366 实例、E2E 共用），
 *     因此：POST 分支仅在 23366 无运行实例时执行，且执行前备份、finally 还原；
 *     23366 有实例时该用例显式 skip，其余用例不受影响。
 *   - 测试实例用 CONSOLE_PORT=23367 + HEADLESS=true，不复用/不干扰 23366。
 *   - 结束后按进程树 taskkill，并清理 cases/test-tmp 与测试语义文件，不动用户数据
 *     （cases/demo、cases/测试展开、cases/验证参数、console/semantics 既有文件）。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 23367;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP_GROUP = 'test-tmp';
const TMP_CASE_DIR = join(ROOT, 'cases', TMP_GROUP);
const MODE_FILE = join(ROOT, 'midscene_run', 'browser-mode.json');
const CACHE_FILE = join(ROOT, 'midscene_run', 'cache', 'web-locate-chain.cache.yaml');
const SEMANTIC_NAME = '集成临时语义';
const OTHER_PORT = 23366; // 用户可能正在使用的实例：只读探活，绝不对它发写请求

let child = null;
let startupLog = '';
let originalModeBytes = null;
let sampleCase = null; // { file, sidecar }
let semanticFile = null; // 绝对路径

// ------------------------------------------------------------------ helpers
function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function postRaw(path, raw) {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

async function json(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __raw: text }; }
}

/** 断言 500 + 错误文案包含片段（服务端所有校验错误都走统一 catch → {ok:false,error}） */
async function expectError(res, fragment) {
  assert.equal(res.status, 500, `期望 500，实际 ${res.status}`);
  const body = await json(res);
  assert.equal(body.ok, false);
  assert.ok(
    String(body.error || '').includes(fragment),
    `错误文案应包含「${fragment}」，实际：${body.error}`,
  );
}

async function waitForState(deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) {
      throw new Error(`服务进程提前退出（exitCode=${child.exitCode}）\n--- 启动日志 ---\n${startupLog}`);
    }
    try {
      const res = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return await res.json();
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`服务 ${deadlineMs / 1000}s 内未就绪（最后错误：${lastErr}）\n--- 启动日志 ---\n${startupLog}`);
}

/** 端口被上次残留实例占用时快速失败，避免误测旧实例 */
async function assertPortFree() {
  try {
    const res = await fetch(`${BASE}/api/state`, { signal: AbortSignal.timeout(1200) });
    if (res.ok) throw new Error(`端口 ${PORT} 已被占用（疑似上次测试残留实例），请先结束占用进程`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('已被占用')) throw err;
    // 连接失败 = 端口空闲
  }
}

/** 23366 上是否有用户实例（只读探活）：有实例时不能删共用缓存文件 */
async function otherInstanceAlive() {
  try {
    const res = await fetch(`http://127.0.0.1:${OTHER_PORT}/api/state`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Windows 下按进程树结束（server 会派生 chromium 子进程），失败回退 child.kill() */
function killTree() {
  if (!child) return Promise.resolve();
  const pid = child.pid;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    if (!pid) return finish();
    const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    const fallback = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish(); }, 5000);
    tk.on('exit', () => { clearTimeout(fallback); finish(); });
    tk.on('error', () => { clearTimeout(fallback); try { child.kill(); } catch { /* gone */ } finish(); });
  });
}

/** 清理单个用例文件（兼容保存失败时 file 未带 cases/ 前缀的兜底清理） */
async function cleanupCaseFile(rel) {
  if (!rel) return;
  const slash = String(rel).replace(/\\/g, '/');
  const full = slash.startsWith('cases/') ? join(ROOT, slash) : join(ROOT, slash);
  await unlink(full).catch(() => {});
  await unlink(`${full}.params.json`).catch(() => {});
}

// ------------------------------------------------------------------ 生命周期
describe('console 集成测试（独立实例 23367）', () => {
  before(async () => {
    await assertPortFree();
    // 强制 fresh 模式：cdp 模式会尝试接管 9222 上的真实 Chrome（可能影响用户浏览器）
    try {
      originalModeBytes = readFileSync(MODE_FILE, 'utf8');
      if (originalModeBytes !== '{"mode":"fresh"}') writeFileSync(MODE_FILE, '{"mode":"fresh"}');
    } catch { originalModeBytes = null; }
    await mkdir(TMP_CASE_DIR, { recursive: true });

    child = spawn(process.execPath, ['console/server.mjs'], {
      env: {
        ...process.env,
        CONSOLE_PORT: String(PORT),
        HEADLESS: 'true',
        CONSOLE_INTERACTIVE: '', // 避免任何 stdin 交互菜单
      },
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const collect = (d) => { startupLog = (startupLog + d.toString()).slice(-8000); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    await waitForState(30000);
  });

  after(async () => {
    await killTree();
    await rm(TMP_CASE_DIR, { recursive: true, force: true });
    if (semanticFile) await unlink(semanticFile).catch(() => {});
    // 还原浏览器模式文件（正常情况下两者都是 {"mode":"fresh"}，不会写回）
    try {
      if (originalModeBytes !== null && readFileSync(MODE_FILE, 'utf8') !== originalModeBytes) {
        writeFileSync(MODE_FILE, originalModeBytes);
      }
    } catch { /* best-effort */ }
  });

  // ---------------------------------------------------------------- A 服务与静态资源
  describe('A. 服务启动与静态资源', () => {
    it('GET /api/state 返回 url/title/agentReady/model/cacheFile/cache/screenshot 契约', async () => {
      const res = await fetch(`${BASE}/api/state`);
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(typeof body.url, 'string');
      assert.equal(typeof body.title, 'string');
      assert.equal(typeof body.agentReady, 'boolean');
      assert.equal(body.agentReady, false, '未执行动作前不应有 agent');
      assert.equal(typeof body.model, 'string');
      assert.ok(body.model.length > 0, 'model 应来自 .env 配置（非空）');
      assert.equal(typeof body.cacheFile, 'string');
      assert.ok(Array.isArray(body.cache), 'cache 应为数组');
      assert.ok(body.screenshot === null || /^data:image\/jpeg;base64,/.test(body.screenshot));
    });

    it('GET / 返回 HTML（含「定位控制台」）且不缓存', async () => {
      const res = await fetch(`${BASE}/`);
      assert.equal(res.status, 200);
      assert.match(String(res.headers.get('content-type')), /^text\/html/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      const html = await res.text();
      assert.ok(html.includes('定位控制台'));
      assert.ok(html.includes('id="btn-run-selected"'));
    });

    it('GET /app.js 与 /style.css 返回对应 MIME 且内容正确', async () => {
      const js = await fetch(`${BASE}/app.js`);
      assert.equal(js.status, 200);
      assert.match(String(js.headers.get('content-type')), /^text\/javascript/);
      const jsText = await js.text();
      assert.ok(jsText.includes('/api/state'));
      assert.ok(jsText.length > 10000);

      const css = await fetch(`${BASE}/style.css`);
      assert.equal(css.status, 200);
      assert.match(String(css.headers.get('content-type')), /^text\/css/);
      assert.ok((await css.text()).includes('{'));
    });

    it('未知路径 /api 路径返回 404（不泄漏源码）', async () => {
      for (const p of ['/nope.js', '/api/nope', '/%2e%2e%2fconsole%2fserver.mjs', '/..%5cpackage.json']) {
        const res = await fetch(`${BASE}${p}`);
        assert.equal(res.status, 404, `${p} 应为 404`);
        assert.equal(await res.text(), '404 Not Found');
      }
    });

    it('方法门控：非 POST 不会落到写接口（GET /api/case/save → 404）', async () => {
      const res = await fetch(`${BASE}/api/case/save`);
      assert.equal(res.status, 404);
      const cases = await json(await fetch(`${BASE}/api/cases`));
      assert.equal(cases.ok, true);
    });
  });

  // ---------------------------------------------------------------- B 导航
  describe('B. /api/navigate', () => {
    it('缺 url → 500 缺少 url', async () => {
      const res = await post('/api/navigate', {});
      await expectError(res, '缺少 url');
    });

    it('导航到本服务前端页（本地 URL，无外网/AI），state.url 同步', async () => {
      const res = await post('/api/navigate', { url: `${BASE}/` });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.url, `${BASE}/`);
      assert.equal(typeof body.title, 'string');
      const state = await json(await fetch(`${BASE}/api/state`));
      assert.equal(state.url, `${BASE}/`);
    });
  });

  // ---------------------------------------------------------------- C 用例库闭环
  describe('C. 用例库 /api/cases + save/load/delete 闭环', () => {
    it('GET /api/cases 返回分组/文件/用例元数据结构', async () => {
      const res = await fetch(`${BASE}/api/cases`);
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.groups));
      for (const group of body.groups) {
        assert.equal(typeof group.group, 'string');
        assert.ok(Array.isArray(group.files));
        for (const file of group.files) {
          assert.match(file.file, /^cases\//);
          assert.equal(file.group, group.group);
          assert.ok(Array.isArray(file.cases));
          for (const c of file.cases) {
            assert.equal(typeof c.name, 'string');
            assert.equal(typeof c.steps, 'number');
            assert.ok(Array.isArray(c.actions));
          }
        }
      }
    });

    it('save 缺 steps → 500 用例至少需要一个步骤', async () => {
      await expectError(await post('/api/case/save', { title: 't' }), '用例至少需要一个步骤');
    });

    it('save tap 缺 prompt → 500 缺少自然语言描述', async () => {
      await expectError(await post('/api/case/save', {
        title: 't', steps: [{ action: 'tap' }],
      }), '缺少自然语言描述');
    });

    it('save input 缺 value → 500 输入动作需要 value', async () => {
      await expectError(await post('/api/case/save', {
        title: 't', steps: [{ action: 'input', prompt: '输入内容' }],
      }), '输入动作需要 value');
    });

    it('save keyboardPress 缺 value → 500 按键动作需要 value', async () => {
      await expectError(await post('/api/case/save', {
        title: 't', steps: [{ action: 'keyboardPress' }],
      }), '按键动作需要 value');
    });

    it('save 未知动作 → 500 未知动作', async () => {
      await expectError(await post('/api/case/save', {
        title: 't', steps: [{ action: 'nope', prompt: 'p' }],
      }), '未知动作 nope');
    });

    it('save 正常（含 params）→ 文件名/目录正确且写入 params sidecar', async () => {
      const res = await post('/api/case/save', {
        title: 'test-集成临时',
        group: TMP_GROUP,
        steps: [
          { action: 'tap', prompt: '点击示例待办输入框' },
          { action: 'assert', prompt: '页面出现待办列表' },
        ],
        params: [{ k: 'name', v: '甲|乙' }, { k: 'phone', v: '13800000000' }],
      });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.match(body.file, /^cases\/test-tmp\/console-test-集成临时-\d{14}\.yaml$/);
      assert.equal(body.dir, TMP_GROUP);
      sampleCase = { file: body.file, sidecar: `${body.file}.params.json` };

      const yaml = readFileSync(join(ROOT, body.file), 'utf8');
      // 文件级 beforeEach gotoUrl（导航用例已把页面停在本地控制台页）
      assert.ok(yaml.includes('beforeEach:'));
      assert.ok(yaml.includes(`  - gotoUrl: "${BASE}/"`));
      assert.ok(yaml.includes('  - name: "test-集成临时"'));
      assert.ok(yaml.includes('      - aiTap:'));
      assert.ok(yaml.includes('      - aiAssert:'));

      assert.ok(existsSync(join(ROOT, sampleCase.sidecar)), 'params sidecar 应写入');
      const sidecar = JSON.parse(readFileSync(join(ROOT, sampleCase.sidecar), 'utf8'));
      assert.deepEqual(sidecar, [{ k: 'name', v: '甲|乙' }, { k: 'phone', v: '13800000000' }]);
    });

    it('保存后出现在 /api/cases（分组 + 用例名 + 动作序列）', async () => {
      const groups = (await json(await fetch(`${BASE}/api/cases`))).groups;
      const group = groups.find((g) => g.group === TMP_GROUP);
      assert.ok(group, '应出现 test-tmp 分组');
      const file = group.files.find((f) => f.file === sampleCase.file);
      assert.ok(file, '保存的文件应出现在用例库');
      assert.equal(file.cases.length, 1);
      assert.equal(file.cases[0].name, 'test-集成临时');
      assert.equal(file.cases[0].steps, 2);
      assert.deepEqual(file.cases[0].actions, ['tap', 'assert']);
    });

    it('POST /api/case/load 回读 title/url/steps/params（sidecar 闭环）', async () => {
      const res = await post('/api/case/load', { file: sampleCase.file });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.title, 'test-集成临时');
      assert.equal(body.url, `${BASE}/`);
      assert.deepEqual(body.steps.map((s) => s.action), ['tap', 'assert']);
      assert.deepEqual(body.steps.map((s) => s.prompt), ['点击示例待办输入框', '页面出现待办列表']);
      assert.deepEqual(body.params, [{ k: 'name', v: '甲|乙' }, { k: 'phone', v: '13800000000' }]);
    });

    it('参数清空后覆盖保存 → 旧 sidecar 被删除，load 不再回读已删参数', async () => {
      const res = await post('/api/case/save', {
        file: sampleCase.file,
        title: 'test-集成临时',
        group: TMP_GROUP,
        steps: [{ action: 'tap', prompt: '点击示例待办输入框' }],
        params: [],
      });
      assert.equal(res.status, 200);
      assert.equal((await json(res)).file, sampleCase.file);
      assert.ok(!existsSync(join(ROOT, sampleCase.sidecar)), '空 params 覆盖保存应删除旧 sidecar');
      const loaded = await json(await post('/api/case/load', { file: sampleCase.file }));
      assert.deepEqual(loaded.params, []);
      assert.deepEqual(loaded.steps.map((s) => s.action), ['tap']);
    });

    it('POST /api/case/delete → yaml 与 sidecar 删除、列表移除', async () => {
      const res = await post('/api/case/delete', { file: sampleCase.file });
      assert.equal(res.status, 200);
      assert.equal((await json(res)).ok, true);
      assert.ok(!existsSync(join(ROOT, sampleCase.file)), 'yaml 应被删除');
      assert.ok(!existsSync(join(ROOT, sampleCase.sidecar)), 'sidecar 应被删除');
      const groups = (await json(await fetch(`${BASE}/api/cases`))).groups;
      const still = groups.some((g) => g.files.some((f) => f.file === sampleCase.file));
      assert.equal(still, false, '删除后不应再出现在用例库');
    });

    it('load 不存在的文件 → 500（ENOENT）', async () => {
      await expectError(await post('/api/case/load', { file: `cases/${TMP_GROUP}/does-not-exist.yaml` }), 'ENOENT');
    });

    it('非法用例路径（traversal）被拒绝，含同前缀兄弟目录绕过', async () => {
      const bad = ['../../package.json', '..\\..\\package.json', '../cases-evil/steal.yaml'];
      for (const file of bad) {
        await expectError(await post('/api/case/load', { file }), '非法用例路径');
        await expectError(await post('/api/case/delete', { file }), '非法用例路径');
        await expectError(await post('/api/case/run', { files: [file] }), '非法用例路径');
      }
      // 关键：越界删除尝试不能真的删掉工程文件
      assert.ok(existsSync(join(ROOT, 'package.json')), 'package.json 必须仍在');
    });

    it('分组名 ".." 不会把用例写到 cases/ 之外', async () => {
      const res = await post('/api/case/save', {
        title: 'test-分组越界',
        group: '..',
        steps: [{ action: 'tap', prompt: '点击示例待办输入框' }],
      });
      const body = await json(res);
      try {
        assert.equal(res.status, 200);
        assert.match(body.file, /^cases\/console-test-分组越界-\d{14}\.yaml$/, '分组越界应回落到 cases/ 根');
        assert.ok(existsSync(join(ROOT, body.file)));
      } finally {
        await cleanupCaseFile(body.file);
      }
    });
  });

  // ---------------------------------------------------------------- D 批量回归
  describe('D. /api/case/run（只验文件选择/解析，不触发 AI）', () => {
    it('缺 files → 500 未选择要运行的用例', async () => {
      await expectError(await post('/api/case/run', {}), '未选择要运行的用例');
      await expectError(await post('/api/case/run', { files: [] }), '未选择要运行的用例');
    });

    it('空 YAML（解析不到用例）→ 该文件记失败，不执行步骤', async () => {
      await writeFile(join(TMP_CASE_DIR, 'empty.yaml'), 'cases:\n', 'utf8');
      const res = await post('/api/case/run', { files: [`cases/${TMP_GROUP}/empty.yaml`] });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.equal(body.total, 1);
      assert.equal(body.passedCount, 0);
      assert.equal(body.results[0].passed, false);
      assert.ok(String(body.results[0].error).includes('未解析到用例'));
    });

    it('不存在文件 → 解析失败条目（不执行）', async () => {
      const res = await post('/api/case/run', { files: [`cases/${TMP_GROUP}/missing.yaml`] });
      const body = await json(res);
      assert.equal(res.status, 200);
      assert.equal(body.passedCount, 0);
      assert.ok(String(body.results[0].error).includes('解析失败'));
    });

    it('只含未知节点的用例解析为 0 步 → passed 且 executed=0（证明未触发 AI）', async () => {
      await writeFile(join(TMP_CASE_DIR, 'unknown-node.yaml'), [
        'cases:',
        '  - name: "仅未知节点"',
        '    steps:',
        '      - aiNope:',
        '          prompt: "不应执行"',
      ].join('\n'), 'utf8');
      const res = await post('/api/case/run', { files: [`cases/${TMP_GROUP}/unknown-node.yaml`] });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.total, 1);
      assert.equal(body.passedCount, 1);
      assert.equal(body.results[0].name, '仅未知节点');
      assert.equal(body.results[0].passed, true);
      assert.equal(body.results[0].executed, 0);
      assert.equal(body.results[0].total, 0);
      assert.equal(body.results[0].screenshot, null);
    });
  });

  // ---------------------------------------------------------------- E 业务语义库
  describe('E. 业务语义库 /api/semantics', () => {
    it('GET /api/semantics 返回 {ok, semantics[]} 结构', async () => {
      const res = await fetch(`${BASE}/api/semantics`);
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.ok, true);
      assert.ok(Array.isArray(body.semantics));
      for (const s of body.semantics) {
        assert.equal(typeof s.name, 'string');
        assert.match(s.file, /\.json$/);
        assert.ok(Array.isArray(s.steps));
        assert.ok(Array.isArray(s.paramNames));
      }
    });

    it('save 缺 name → 500 语义名称不能为空', async () => {
      await expectError(await post('/api/semantic/save', { steps: [{ action: 'tap', prompt: 'p' }] }), '语义名称不能为空');
    });

    it('save 缺 steps → 500 语义至少包含一个步骤', async () => {
      await expectError(await post('/api/semantic/save', { name: 'x' }), '语义至少包含一个步骤');
    });

    it('save 未知动作 → 500 未知动作', async () => {
      await expectError(await post('/api/semantic/save', {
        name: 'x', steps: [{ action: 'nope', prompt: 'p' }],
      }), '未知动作 nope');
    });

    it('save 语义步骤（sem:）→ 500 语义不支持嵌套引用', async () => {
      await expectError(await post('/api/semantic/save', {
        name: 'x', steps: [{ action: 'sem:另一个语义', prompt: 'p' }],
      }), '语义不支持嵌套引用其他语义');
    });

    it('save 正常 → 写入 console/semantics/<slug>.json', async () => {
      const res = await post('/api/semantic/save', {
        name: SEMANTIC_NAME,
        steps: [
          { action: 'tap', prompt: '点击 ${目标按钮} 并检查 ${{ENV_TOKEN}}', xpath: '', value: '' },
          { action: 'input', prompt: '输入 ${用户名}', xpath: '', value: '${密码}' },
          { action: 'act', prompt: '旧语法 {{旧参数}}', xpath: '', value: '' },
        ],
      });
      assert.equal(res.status, 200);
      const body = await json(res);
      assert.equal(body.name, SEMANTIC_NAME);
      assert.equal(body.file, `console/semantics/${SEMANTIC_NAME}.json`);
      semanticFile = join(ROOT, body.file);
      assert.ok(existsSync(semanticFile));
      const saved = JSON.parse(readFileSync(semanticFile, 'utf8'));
      assert.equal(saved.name, SEMANTIC_NAME);
      assert.equal(saved.steps.length, 3);
    });

    it('列表 paramNames 识别 ${name}、排除 ${{ENV}}、兼容 {{旧语法}}', async () => {
      const body = await json(await fetch(`${BASE}/api/semantics`));
      const item = body.semantics.find((s) => s.name === SEMANTIC_NAME);
      assert.ok(item, '应能列出刚保存的语义');
      assert.deepEqual(item.paramNames, ['目标按钮', '用户名', '密码', '旧参数']);
      assert.ok(!item.paramNames.some((n) => n.includes('ENV')), '${{ENV}} 不应计入形参');
      assert.equal(item.steps.length, 3);
    });

    it('delete 后从列表移除且文件消失', async () => {
      const res = await post('/api/semantic/delete', { name: SEMANTIC_NAME });
      assert.equal(res.status, 200);
      assert.equal((await json(res)).ok, true);
      const body = await json(await fetch(`${BASE}/api/semantics`));
      assert.ok(!body.semantics.some((s) => s.name === SEMANTIC_NAME));
      assert.ok(!existsSync(semanticFile), '语义 json 应被删除');
      semanticFile = null;
    });

    it('delete 不存在的语义 → 500（ENOENT）', async () => {
      await expectError(await post('/api/semantic/delete', { name: '根本不存在的语义' }), 'ENOENT');
    });
  });

  // ---------------------------------------------------------------- F 请求体与 /api/run 校验
  describe('F. 请求体解析与 /api/run 校验（不触发 AI）', () => {
    it('非法 JSON 请求体 → 500 请求体不是合法 JSON', async () => {
      await expectError(await postRaw('/api/case/save', 'not-a-json'), '请求体不是合法 JSON');
    });

    it('POST /api/run 缺 prompt → 500 缺少自然语言指令', async () => {
      await expectError(await post('/api/run', { action: 'tap' }), '缺少自然语言指令');
    });

    it('POST /api/run keyboardPress 缺 value → 500 按键动作需要 value', async () => {
      await expectError(await post('/api/run', { action: 'keyboardPress' }), '按键动作需要 value');
    });

    it('POST /api/run scroll 方向无效 → 500 滚动方向无效', async () => {
      await expectError(await post('/api/run', { action: 'scroll', value: 'sideways' }), '滚动方向无效');
    });

    it('POST /api/run 未知动作 → 500 未知动作', async () => {
      await expectError(await post('/api/run', { action: 'no-such', prompt: '触发未知动作校验' }), '未知动作');
    });
  });

  // ---------------------------------------------------------------- G agent / 缓存端点
  describe('G. /api/agent/reset 与缓存端点', () => {
    it('POST /api/agent/reset → {ok:true} 且 state.agentReady 回落 false', async () => {
      const res = await post('/api/agent/reset', {});
      assert.equal(res.status, 200);
      assert.equal((await json(res)).ok, true);
      const state = await json(await fetch(`${BASE}/api/state`));
      assert.equal(state.agentReady, false);
    });

    it('/api/state.cacheFile 指向工程缓存文件，cache 为 locate 记录数组', async () => {
      const state = await json(await fetch(`${BASE}/api/state`));
      assert.equal(state.cacheFile, join(ROOT, 'midscene_run', 'cache', 'web-locate-chain.cache.yaml'));
      for (const record of state.cache) {
        assert.equal(typeof record.prompt, 'string');
        assert.ok(Array.isArray(record.xpaths));
      }
    });

    it('GET /api/cache/clear 非 POST → 404（不落到 API 分支，且不触碰缓存文件）', async () => {
      // 不能硬要求缓存文件存在：midscene_run/ 是可重建的运行目录，可能已被清理为空
      // （t6 收尾会整体删除）。这里只断言「GET 前后缓存文件的存在性不变」——
      // 既覆盖 404 门控，也证明该端点不会误删/误建共享缓存。
      const existedBefore = existsSync(CACHE_FILE);
      const res = await fetch(`${BASE}/api/cache/clear`);
      assert.equal(res.status, 404);
      assert.equal(existsSync(CACHE_FILE), existedBefore, 'GET /api/cache/clear 不应改变缓存文件状态');
    });

    it('POST /api/cache/clear 契约（23366 有运行实例时跳过：共用缓存文件会被删）', async (t) => {
      if (await otherInstanceAlive()) {
        t.skip(`23366 上有运行中的实例共用 ${CACHE_FILE}，跳过会删除缓存的 POST 用例`);
        return;
      }
      const backup = existsSync(CACHE_FILE) ? readFileSync(CACHE_FILE) : null;
      try {
        const res = await post('/api/cache/clear', {});
        assert.equal(res.status, 200);
        assert.deepEqual(await json(res), { ok: true, cache: [] });
        assert.equal(existsSync(CACHE_FILE), false, 'clear 应删除缓存文件');
      } finally {
        if (backup) writeFileSync(CACHE_FILE, backup); // 还原共享缓存，避免影响后续回归
      }
      const state = await json(await fetch(`${BASE}/api/state`));
      assert.ok(Array.isArray(state.cache));
      if (backup) assert.ok(state.cache.length > 0, '还原后应能重新读到缓存记录');
    });
  });
});
