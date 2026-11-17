/**
 * console/lib.mjs 单元测试（node:test + node:assert/strict）
 * 运行（项目根）：node --test console/test/unit.test.mjs
 *
 * 覆盖边界说明（重要）：
 *   - 本文件只测 console/lib.mjs 的纯函数（YAML/缓存文本处理 + 动作常量映射）。
 *   - 前端 console/public/app.js 是 classic script（无 import/export，index.html 以非 module 加载），
 *     无法 import lib.mjs；其参数逻辑（subst/extractParams/expandSteps/expandParamRounds/parseKv）
 *     由 param-logic.test.mjs（从源码标记区抽取后在 vm 中执行）与流程级 E2E 覆盖，
 *     不在本文件内重复实现。
 *   - ${name}（项目变量）与 ${{ENV}}（环境变量）是 Midscene 官方变量语法，lib 只做 YAML 文本处理，
 *     必须原样保留、不得转义或改写；下面的「变量语法保真」用例守护这一点。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  yamlScalar, parseCache, parseCaseYaml, buildCaseYaml,
  recordsForPrompt, snapshotOf,
  ACTION_NODES, LOCATING_ACTIONS, SEMANTIC_LABEL, NODE_TO_ACTION,
} from '../lib.mjs';

// 与 midscene_run/cache/<id>.cache.yaml 同款结构（Midscene 1.17.4 实际产物：
// caches[] 下同时可能有 plan 与 locate 两类记录，locate 的 xpath 嵌在 cache: 下）
const REAL_CACHE = [
  'midsceneVersion: 1.17.4',
  'cacheId: web-locate-chain',
  'caches:',
  '  - type: locate',
  '    prompt: 搜索框',
  '    cache:',
  '      xpaths:',
  '        - /html/body/div[1]/div[1]/form[1]/span[1]/input[1]',
  '  - type: locate',
  '    prompt: 百度一下',
  '    cache:',
  '      xpaths:',
  '        - /html/body/div[1]/div[1]/form[1]/span[2]/input[1]',
  '        - //button[@type="submit"]',
].join('\n');

describe('yamlScalar', () => {
  it('双引号字符串去引号', () => {
    assert.equal(yamlScalar('"add a todo"'), 'add a todo');
  });
  it('双引号内 JSON 转义被解析', () => {
    assert.equal(yamlScalar('"line\\nbreak"'), 'line\nbreak');
    assert.equal(yamlScalar('"a\\tb"'), 'a\tb');
    assert.equal(yamlScalar('"a\\\\b"'), 'a\\b');
    assert.equal(yamlScalar('"\\u4e2d"'), '中');
  });
  it('单引号字符串去引号', () => {
    assert.equal(yamlScalar("'hello'"), 'hello');
  });
  it("单引号标量内的 '' 还原为一个字面单引号（YAML 1.2 §7.3.2；js-yaml 的真实产物）", () => {
    // js-yaml.dump({prompt:"a: it's"}) → prompt: 'a: it''s'
    assert.equal(yamlScalar("'a: it''s'"), "a: it's");
    assert.equal(yamlScalar("'''a'' and ''b'''"), "'a' and 'b'");
    assert.equal(yamlScalar("''"), '');
  });
  it('整数解析为 Number', () => {
    assert.equal(yamlScalar('42'), 42);
    assert.equal(typeof yamlScalar('42'), 'number');
    assert.equal(yamlScalar('-7'), -7);
  });
  it('小数解析为 Number', () => {
    assert.equal(yamlScalar('3.14'), 3.14);
    assert.equal(yamlScalar('-0.5'), -0.5);
  });
  it('true / false 解析为布尔', () => {
    assert.equal(yamlScalar('true'), true);
    assert.equal(yamlScalar('false'), false);
  });
  it('引号包裹的数字/布尔保持字符串类型（buildCaseYaml 全量加引号，往返不丢类型）', () => {
    assert.equal(yamlScalar('"600"'), '600');
    assert.equal(typeof yamlScalar('"600"'), 'string');
    assert.equal(yamlScalar('"true"'), 'true');
    assert.equal(typeof yamlScalar('"true"'), 'string');
  });
  it('裸标量原样返回字符串', () => {
    assert.equal(yamlScalar('https://todomvc.com/examples/react/dist/#/'), 'https://todomvc.com/examples/react/dist/#/');
    assert.equal(yamlScalar('hello world'), 'hello world');
  });
  it('非 YAML 特殊字面量不被改写', () => {
    assert.equal(yamlScalar('null'), 'null');
    assert.equal(yamlScalar('NaN'), 'NaN');
    assert.equal(yamlScalar('1e3'), '1e3');
  });
  it('空串/空白/null/undefined 返回空串', () => {
    assert.equal(yamlScalar(''), '');
    assert.equal(yamlScalar('   '), '');
    assert.equal(yamlScalar(null), '');
    assert.equal(yamlScalar(undefined), '');
    assert.equal(yamlScalar('""'), '');
  });
});

describe('parseCache', () => {
  // 旧格式 fixture（xpaths 直接跟在 prompt 后、无 cache: 嵌套）：保持向后兼容
  const cacheText = [
    '# midscene cache',
    '  - type: plan',
    '    prompt: "plan something"',
    '    plan:',
    '      - step one',
    '  - type: locate',
    '    prompt: "add a todo"',
    '      xpaths:',
    '        - /html/body/section/div/input',
    '        - /html/body/section/ul/li/input',
    '  - type: locate',
    "    prompt: 'toggle all'",
    '      xpaths:',
    '        - //label',
  ].join('\n');

  it('真实 Midscene 1.17.4 格式（caches[] + cache: 嵌套 xpaths）可解析', () => {
    const records = parseCache(REAL_CACHE);
    assert.equal(records.length, 2);
    assert.equal(records[0].prompt, '搜索框');
    assert.deepEqual(records[0].xpaths, ['/html/body/div[1]/div[1]/form[1]/span[1]/input[1]']);
    assert.equal(records[1].prompt, '百度一下');
    assert.deepEqual(records[1].xpaths, [
      '/html/body/div[1]/div[1]/form[1]/span[2]/input[1]',
      '//button[@type="submit"]',
    ]);
  });
  it('解析旧格式（无 cache: 嵌套）的多条 locate 记录', () => {
    const records = parseCache(cacheText);
    assert.equal(records.length, 2);
    assert.equal(records[0].prompt, 'add a todo');
    assert.equal(records[1].prompt, 'toggle all');
  });
  it('同一记录的多条 xpath 全部保留', () => {
    const [first] = parseCache(cacheText);
    assert.deepEqual(first.xpaths, ['/html/body/section/div/input', '/html/body/section/ul/li/input']);
  });
  it('plan 类型记录被跳过', () => {
    const records = parseCache(cacheText);
    assert.ok(records.every((r) => r.prompt !== 'plan something'));
    assert.equal(parseCache('  - type: plan\n    prompt: "p"\n    plan:\n      - s').length, 0);
  });
  it('plan 记录即使出现在 locate 之后，也不会覆盖上一条 locate 的 prompt', () => {
    // Midscene 落盘时会把 plan 排在 locate 之前（task-cache.ts 的 sort），
    // 但解析器不能依赖排序：非 locate 记录必须显式断开当前记录。
    const mixed = [
      'caches:',
      '  - type: locate',
      '    prompt: 下单按钮',
      '    cache:',
      '      xpaths:',
      '        - /html/body/button[2]',
      '  - type: plan',
      '    prompt: 下单计划',
      '    yamlWorkflow: |-',
      '      - aiTap: 下单',
    ].join('\n');
    const records = parseCache(mixed);
    assert.equal(records.length, 1);
    assert.equal(records[0].prompt, '下单按钮');
    assert.deepEqual(records[0].xpaths, ['/html/body/button[2]']);
  });
  it('带引号的 prompt 按 YAML 规则还引号（Midscene 用 js-yaml dump，含冒号/井号时被引起来）', () => {
    const quoted = [
      'caches:',
      '  - type: locate',
      "    prompt: 'a: it''s'",
      '    cache:',
      '      xpaths:',
      '        - /html/body/x[1]',
      '  - type: locate',
      '    prompt: "line\\nbreak"',
      '    cache:',
      '      xpaths:',
      '        - /html/body/y[1]',
    ].join('\n');
    const records = parseCache(quoted);
    assert.equal(records[0].prompt, "a: it's");
    assert.equal(records[1].prompt, 'line\nbreak');
  });
  it('xpath 前后空白被裁剪', () => {
    const padded = [
      '  - type: locate',
      '    prompt: 带空格',
      '    cache:',
      '      xpaths:',
      '        -   /html/body/x[1]   ',
    ].join('\n');
    assert.deepEqual(parseCache(padded)[0].xpaths, ['/html/body/x[1]']);
  });
  it('CRLF 换行同样可解析', () => {
    const crlf = REAL_CACHE.replace(/\n/g, '\r\n');
    assert.deepEqual(parseCache(crlf), parseCache(REAL_CACHE));
  });
  it('损坏输入返回空数组', () => {
    assert.deepEqual(parseCache(''), []);
    assert.deepEqual(parseCache(null), []);
    assert.deepEqual(parseCache('just random text\nno structure here'), []);
    assert.deepEqual(parseCache('{"json":"not yaml"}'), []);
  });
});

// 仓库里真实存在的缓存文件（只读冒烟；不存在则跳过——集成层可能清理它）
const REAL_CACHE_FILE = new URL('../../midscene_run/cache/web-locate-chain.cache.yaml', import.meta.url);
describe('parseCache × 真实缓存文件', () => {
  it('仓库内 midscene_run 缓存文件可被解析出 locate 记录', { skip: !existsSync(REAL_CACHE_FILE) && '缓存文件不存在' }, () => {
    const records = parseCache(readFileSync(REAL_CACHE_FILE, 'utf8'));
    assert.ok(records.length >= 1, `应解析出至少 1 条 locate 记录，实际 ${records.length}`);
    for (const record of records) {
      assert.equal(typeof record.prompt, 'string');
      assert.ok(Array.isArray(record.xpaths));
      // 真实 xpath 既可能是绝对路径 /html/...，也可能是 //label 形式
      for (const xpath of record.xpaths) assert.match(xpath, /^\/{1,2}[^/\s]/);
    }
  });
});

describe('parseCaseYaml', () => {
  // 旧格式 fixture（case 级 beforeEach）：parseCaseYaml 需向后兼容仍可解析
  const caseYaml = [
    '# 由定位控制台生成（测试用例格式：标题 + 步骤 + 每步可选 xpath）',
    'cases:',
    '  - name: "下单冒烟"',
    '    tags: [console]',
    '    beforeEach:',
    '      - gotoUrl: "https://todomvc.com/examples/react/dist/#/"',
    '    steps:',
    '      - aiTap:',
    '          prompt: "新增待办"',
    '          options:',
    '            xpath: "/html/body/section/div/input"',
    '      - aiInput:',
    '          prompt: "输入内容"',
    '          value: "买牛奶"',
    '      - aiKeyboardPress:',
    '          keyName: "Enter"',
    '      - aiScroll:',
    '          options:',
    '            direction: "down"',
    '            distance: 600',
    '      - aiUnknownNode:',
    '          prompt: "未知节点应被跳过"',
    '      - aiAct:',
    '          prompt: "完成任务"',
    '  - name: "第二个用例"',
    '    tags: [smoke]',
    '    steps:',
    '      - aiTap:',
    '          prompt: "another"',
    '    notes: 步骤之后的段落应被忽略',
  ].join('\n');

  it('解析多个 case', () => {
    const cases = parseCaseYaml(caseYaml);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].name, '下单冒烟');
    assert.equal(cases[1].name, '第二个用例');
  });
  it('beforeEach gotoUrl 提取为 url（无 beforeEach 时为空）', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.url, 'https://todomvc.com/examples/react/dist/#/');
    const minimal = parseCaseYaml('cases:\n  - name: "x"\n    steps:\n      - aiTap:\n          prompt: "p"');
    assert.equal(minimal[0].url, '');
  });
  it('aiTap 的 options.xpath 提取', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.steps[0].action, 'tap');
    assert.equal(first.steps[0].prompt, '新增待办');
    assert.equal(first.steps[0].xpath, '/html/body/section/div/input');
  });
  it('aiInput 的 value 提取', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.steps[1].action, 'input');
    assert.equal(first.steps[1].value, '买牛奶');
  });
  it('aiKeyboardPress 的 keyName 映射为 value', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.steps[2].action, 'keyboardPress');
    assert.equal(first.steps[2].value, 'Enter');
  });
  it('aiScroll 的 direction/distance 合成 value', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.steps[3].action, 'scroll');
    assert.equal(first.steps[3].value, 'down 600');
  });
  it('未知节点及其内容被跳过', () => {
    const [first] = parseCaseYaml(caseYaml);
    assert.equal(first.steps.length, 5);
    assert.equal(first.steps[4].action, 'act');
    assert.equal(first.steps[4].prompt, '完成任务');
  });
  it('非步骤段落（tags/notes）被忽略', () => {
    const cases = parseCaseYaml(caseYaml);
    assert.deepEqual(cases[1].steps.map((s) => s.action), ['tap']);
    assert.equal(cases[1].steps[0].prompt, 'another');
  });
  it('文件级 beforeEach gotoUrl（新格式）应用于全文件用例', () => {
    const fileYaml = [
      '# 由定位控制台生成',
      'beforeEach:',
      '  - gotoUrl: "https://example.com/"',
      'cases:',
      '  - name: "c1"',
      '    tags: [console]',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p1"',
      '  - name: "c2"',
      '    tags: [console]',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p2"',
    ].join('\n');
    const cases = parseCaseYaml(fileYaml);
    assert.equal(cases.length, 2);
    assert.equal(cases[0].url, 'https://example.com/');
    assert.equal(cases[1].url, 'https://example.com/');
    // 文件级 gotoUrl 不得泄漏进 steps，也不得吞掉步骤
    assert.equal(cases[0].steps.length, 1);
    assert.equal(cases[0].steps[0].action, 'tap');
    assert.equal(cases[0].steps[0].prompt, 'p1');
    assert.equal(cases[0].steps[0].xpath, '');
  });
  it('文件级与 case 级 beforeEach 同时存在：case 级覆盖文件级，未覆盖的沿用文件级', () => {
    const mixed = [
      'beforeEach:',
      '  - gotoUrl: "https://file-level.example/"',
      'cases:',
      '  - name: "c1"',
      '    beforeEach:',
      '      - gotoUrl: "https://case-level.example/"',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p1"',
      '  - name: "c2"',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p2"',
    ].join('\n');
    const cases = parseCaseYaml(mixed);
    assert.equal(cases[0].url, 'https://case-level.example/');
    assert.equal(cases[1].url, 'https://file-level.example/');
  });
  it('官方示例的文件级 lifecycle（todo.seed 等）不影响解析', () => {
    const mixed = [
      'beforeAll:',
      '  - setViewportSize:',
      '      width: 1280',
      '      height: 720',
      'beforeEach:',
      '  - todo.setup: {}',
      '  - todo.seed:',
      '      items:',
      '        - a',
      'cases:',
      '  - name: "x"',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p"',
    ].join('\n');
    const [c] = parseCaseYaml(mixed);
    assert.equal(c.name, 'x');
    assert.equal(c.url, '');
    assert.equal(c.steps.length, 1);
  });
  it('步骤内 $ 元数据段（timeout 等）被忽略', () => {
    const withMeta = [
      'cases:',
      '  - name: "m"',
      '    steps:',
      '      - aiTap:',
      '          prompt: "p1"',
      '          $:',
      '            timeout: 30000',
      '      - aiAct:',
      '          prompt: "p2"',
    ].join('\n');
    const [c] = parseCaseYaml(withMeta);
    assert.deepEqual(c.steps.map((s) => s.action), ['tap', 'act']);
    assert.deepEqual(c.steps.map((s) => s.prompt), ['p1', 'p2']);
  });
  it('options 写在 prompt 之前也能解析（手写/官方 YAML 顺序不固定）', () => {
    const reversed = [
      'cases:',
      '  - name: "r"',
      '    steps:',
      '      - aiTap:',
      '          options:',
      '            xpath: "/html/body/x[1]"',
      '          prompt: "先选项后 prompt"',
    ].join('\n');
    const [c] = parseCaseYaml(reversed);
    assert.equal(c.steps[0].xpath, '/html/body/x[1]');
    assert.equal(c.steps[0].prompt, '先选项后 prompt');
  });
  it('CRLF 换行的用例文件与 LF 解析结果一致', () => {
    assert.deepEqual(parseCaseYaml(caseYaml.replace(/\n/g, '\r\n')), parseCaseYaml(caseYaml));
  });
  it('空文本/无 cases 的文件返回空数组', () => {
    assert.deepEqual(parseCaseYaml(''), []);
    assert.deepEqual(parseCaseYaml('# 只有注释\n'), []);
    assert.deepEqual(parseCaseYaml('cases:\n'), []);
  });
});

describe('buildCaseYaml', () => {
  const steps = [
    { action: 'tap', prompt: '新增待办', xpath: '/html/body/section/div/input', value: '' },
    { action: 'input', prompt: '输入内容', value: '买牛奶', xpath: '' },
    { action: 'keyboardPress', prompt: '', value: 'Enter', xpath: '' },
    { action: 'scroll', prompt: '', value: 'down 600', xpath: '' },
    { action: 'act', prompt: '完成任务', xpath: '', value: '' },
  ];

  it('build→parse→build 幂等', () => {
    const once = buildCaseYaml({ title: '下单冒烟', steps, url: 'https://todomvc.com/examples/react/dist/#/' });
    const [parsed] = parseCaseYaml(once);
    const twice = buildCaseYaml({ title: parsed.name, steps: parsed.steps, url: parsed.url });
    assert.equal(twice, once);
  });
  it('生成的文件级 beforeEach + gotoUrl 逐行格式固定', () => {
    const yaml = buildCaseYaml({
      title: '登录冒烟',
      url: 'https://example.com/login?q=${kw}',
      steps: [
        { action: 'tap', prompt: '点击 ${button} 按钮', xpath: '/html/body/button[1]', value: '' },
        { action: 'keyboardPress', prompt: '', value: 'Enter', xpath: '' },
      ],
    });
    const expected = [
      '# 由定位控制台生成（测试用例格式：标题 + 步骤 + 每步可选 xpath）',
      'beforeEach:',
      '  - gotoUrl: "https://example.com/login?q=${kw}"',
      'cases:',
      '  - name: "登录冒烟"',
      '    tags: [console]',
      '    steps:',
      '      - aiTap:',
      '          prompt: "点击 ${button} 按钮"',
      '          options:',
      '            xpath: "/html/body/button[1]"',
      '      - aiKeyboardPress:',
      '          keyName: "Enter"',
    ].join('\n') + '\n';
    assert.equal(yaml, expected);
  });
  it('有 url 才输出文件级 beforeEach gotoUrl（runner 仅接受文件级生命周期）', () => {
    const act = { action: 'act', prompt: 'p', xpath: '', value: '' };
    const withUrl = buildCaseYaml({ title: 't', steps: [act], url: 'https://example.com/' });
    assert.ok(withUrl.includes('beforeEach:'));
    assert.ok(withUrl.includes('  - gotoUrl: "https://example.com/"'));
    // beforeEach 必须只出现一次、位于 cases 之前（文件级），且不得出现在 case 内（4 缩进）
    assert.equal(withUrl.split('beforeEach:').length - 1, 1);
    assert.ok(withUrl.indexOf('beforeEach:') < withUrl.indexOf('cases:'));
    assert.ok(!withUrl.includes('    beforeEach:'));
    const noUrl = buildCaseYaml({ title: 't', steps: [act], url: '' });
    assert.ok(!noUrl.includes('beforeEach'));
    assert.ok(!noUrl.includes('gotoUrl'));
  });
  it('未知动作抛错（避免生成 runner 不认识的节点）', () => {
    assert.throws(
      () => buildCaseYaml({ title: 'x', steps: [{ action: 'nope', prompt: 'p' }], url: '' }),
      /未知动作：nope/,
    );
  });
  it('空 prompt 的整页动作（keyboardPress/scroll）不输出 prompt 行', () => {
    const yaml = buildCaseYaml({
      title: 'page-level',
      steps: [
        { action: 'keyboardPress', prompt: '', value: 'Escape', xpath: '' },
        { action: 'scroll', prompt: '', value: 'up', xpath: '' },
      ],
      url: '',
    });
    assert.ok(!yaml.includes('prompt:'));
    assert.ok(yaml.includes('          keyName: "Escape"'));
    assert.ok(yaml.includes('            direction: "up"'));
  });
  it('input 无 xpath 时不输出 options 段', () => {
    const yaml = buildCaseYaml({
      title: 'in',
      steps: [{ action: 'input', prompt: '输入内容', value: '买牛奶', xpath: '' }],
      url: '',
    });
    assert.ok(!yaml.includes('options:'));
    assert.ok(yaml.includes('          value: "买牛奶"'));
  });
  it('scroll 带 xpath 时 xpath 写在 options 内、位于 direction/distance 之后', () => {
    const yaml = buildCaseYaml({
      title: 's',
      steps: [{ action: 'scroll', prompt: '滚动列表', value: 'down 500', xpath: "//div[@id='list']" }],
      url: '',
    });
    const expected = [
      '      - aiScroll:',
      '          prompt: "滚动列表"',
      '          options:',
      '            direction: "down"',
      '            distance: 500',
      "            xpath: \"//div[@id='list']\"",
    ].join('\n');
    assert.ok(yaml.includes(expected));
  });
  it('scroll 输出 direction + distance（仅方向时不输出 distance）', () => {
    const withDist = buildCaseYaml({ title: 's', steps: [{ action: 'scroll', prompt: '', value: 'down 600', xpath: '' }], url: '' });
    assert.ok(withDist.includes('            direction: "down"'));
    assert.ok(withDist.includes('            distance: 600'));
    const noDist = buildCaseYaml({ title: 's', steps: [{ action: 'scroll', prompt: '', value: 'up', xpath: '' }], url: '' });
    assert.ok(noDist.includes('            direction: "up"'));
    assert.ok(!noDist.includes('distance'));
  });
  it('含双引号的 prompt 正确转义且可往返', () => {
    const yaml = buildCaseYaml({ title: 'quote', steps: [{ action: 'act', prompt: '说 "你好"', xpath: '', value: '' }], url: '' });
    assert.ok(yaml.includes('prompt: "说 \\"你好\\""'));
    const [parsed] = parseCaseYaml(yaml);
    assert.equal(parsed.steps[0].prompt, '说 "你好"');
  });
  it('19 个动作全部 build→parse→build 往返一致', () => {
    const valueOf = { input: 'v', keyboardPress: 'Enter', scroll: 'down 300' };
    const allSteps = Object.keys(ACTION_NODES).map((action) => ({
      action,
      prompt: `p-${action}`,
      value: valueOf[action] || '',
      xpath: ACTION_NODES[action].xpath ? `//x-${action}` : '',
    }));
    const yaml = buildCaseYaml({ title: 'all', steps: allSteps, url: '' });
    const [parsed] = parseCaseYaml(yaml);
    assert.equal(parsed.steps.length, allSteps.length);
    allSteps.forEach((orig, i) => {
      const got = parsed.steps[i];
      assert.equal(got.action, orig.action, `第 ${i + 1} 步动作不一致`);
      assert.equal(got.prompt, orig.prompt, `第 ${i + 1} 步 prompt 不一致`);
      assert.equal(got.value, orig.value, `第 ${i + 1} 步 value 不一致`);
      assert.equal(got.xpath, orig.xpath, `第 ${i + 1} 步 xpath 不一致`);
    });
    assert.equal(buildCaseYaml({ title: parsed.name, steps: parsed.steps, url: parsed.url }), yaml);
  });
  it('非定位动作即使传入 xpath 也不写入 YAML', () => {
    for (const [action, cfg] of Object.entries(ACTION_NODES)) {
      if (cfg.xpath) continue;
      const yaml = buildCaseYaml({
        title: 'no-xpath',
        steps: [{ action, prompt: 'p', value: action === 'input' ? 'v' : '', xpath: '//should-not-appear' }],
        url: '',
      });
      assert.ok(!yaml.includes('should-not-appear'), `${action} 不应写入 xpath`);
    }
  });
});

describe('变量语法保真（${name} / ${{ENV}}）', () => {
  // 官方语法：${name} 读项目 variables，${{ENV_NAME}} 读环境变量；console 保存前只展开
  // ${name}，${{ENV}} 原样交给 runner。lib 只处理 YAML 文本，二者都必须原样保真。
  const varSteps = [
    { action: 'tap', prompt: '点击 ${button} 按钮', xpath: "//div[@id='${panel}']", value: '' },
    { action: 'input', prompt: '输入 ${user} 的姓名', value: '${{USER_NAME}}', xpath: '' },
    { action: 'assert', prompt: '断言 ${{ENV_FLAG}} 为真', value: '', xpath: '' },
    { action: 'act', prompt: '同时用 ${a} 和 ${{B}}', value: '', xpath: '' },
  ];

  it('buildCaseYaml 原样保留 ${name} 与 ${{ENV}}（不转义、不改写）', () => {
    const yaml = buildCaseYaml({ title: '变量用例 ${case_id}', steps: varSteps, url: 'https://example.com/?q=${kw}' });
    for (const raw of ['${button}', '${panel}', '${user}', '${{USER_NAME}}', '${{ENV_FLAG}}', '${case_id}', '${kw}']) {
      assert.ok(yaml.includes(raw), `生成结果应包含原始变量写法 ${raw}`);
    }
    // 不允许出现被 JSON/转义破坏的写法
    assert.ok(!yaml.includes('\\${'), '不得把 ${...} 转义成 \\${...}');
    assert.ok(!yaml.includes('$ {{'), '不得在 $ 与 { 之间插入空格');
    assert.ok(!yaml.includes('{{ USER_NAME }}'), '不得改写 ${{ENV}} 内部空白');
  });

  it('build→parse→build 对含变量的用例幂等，且变量文本逐字保真', () => {
    const yaml = buildCaseYaml({ title: '变量用例 ${case_id}', steps: varSteps, url: 'https://example.com/?q=${kw}' });
    const [parsed] = parseCaseYaml(yaml);
    assert.equal(parsed.name, '变量用例 ${case_id}');
    assert.equal(parsed.url, 'https://example.com/?q=${kw}');
    assert.deepEqual(parsed.steps.map((s) => s.prompt), varSteps.map((s) => s.prompt));
    assert.equal(parsed.steps[0].xpath, "//div[@id='${panel}']");
    assert.equal(parsed.steps[1].value, '${{USER_NAME}}');
    assert.equal(buildCaseYaml({ title: parsed.name, steps: parsed.steps, url: parsed.url }), yaml);
  });

  it('parseCaseYaml 对官方/手写 YAML 中未加引号的变量写法也原样返回', () => {
    const handWritten = [
      'beforeEach:',
      '  - gotoUrl: https://example.com/?q=${kw}',
      'cases:',
      '  - name: 变量用例 ${case_id}',
      '    steps:',
      '      - aiTap:',
      '          prompt: 点击 ${button} 按钮',
      '      - aiInput:',
      '          prompt: 输入姓名',
      '          value: ${{USER_NAME}}',
    ].join('\n');
    const [c] = parseCaseYaml(handWritten);
    assert.equal(c.name, '变量用例 ${case_id}');
    assert.equal(c.url, 'https://example.com/?q=${kw}');
    assert.equal(c.steps[0].prompt, '点击 ${button} 按钮');
    assert.equal(c.steps[1].value, '${{USER_NAME}}');
  });
});

describe('recordsForPrompt / snapshotOf / 常量映射', () => {
  it('recordsForPrompt 按 prompt 过滤', () => {
    const records = [{ prompt: 'a', xpaths: ['/x1'] }, { prompt: 'b', xpaths: ['/x2'] }, { prompt: 'a', xpaths: ['/x3'] }];
    assert.deepEqual(recordsForPrompt(records, 'a').map((r) => r.xpaths), [['/x1'], ['/x3']]);
    assert.deepEqual(recordsForPrompt(records, 'zzz'), []);
  });
  it('snapshotOf 序列化 xpath 数组', () => {
    const records = [{ prompt: 'a', xpaths: ['/x1'] }, { prompt: 'a', xpaths: ['/x3'] }];
    assert.equal(snapshotOf(records, 'a'), JSON.stringify([['/x1'], ['/x3']]));
    assert.equal(snapshotOf(records, 'zzz'), '[]');
  });
  it('snapshotOf 是三层缓存判定依据：同 prompt 稳定、xpath 变化即变化', () => {
    const before = [{ prompt: '搜索框', xpaths: ['/old'] }];
    const same = [{ prompt: '搜索框', xpaths: ['/old'] }, { prompt: '其它', xpaths: ['/other'] }];
    const after = [{ prompt: '搜索框', xpaths: ['/new'] }];
    assert.equal(snapshotOf(before, '搜索框'), snapshotOf(same, '搜索框')); // Tier 2 命中
    assert.notEqual(snapshotOf(before, '搜索框'), snapshotOf(after, '搜索框')); // 缓存失效
    assert.equal(snapshotOf([], '搜索框'), snapshotOf(same, '不存在的 prompt'));
  });
  it('ACTION_NODES / NODE_TO_ACTION 一一对应且节点名唯一', () => {
    for (const [action, cfg] of Object.entries(ACTION_NODES)) {
      assert.equal(NODE_TO_ACTION[cfg.node], action);
      assert.match(cfg.node, /^ai[A-Z]/, `${action} 的节点名应为 aiXxx`);
    }
    assert.equal(Object.keys(ACTION_NODES).length, 19);
    assert.equal(Object.keys(NODE_TO_ACTION).length, Object.keys(ACTION_NODES).length);
  });
  it('动作 → YAML 节点映射固定（前端/服务端/runner 三方契约）', () => {
    const expected = {
      tap: 'aiTap', doubleClick: 'aiDoubleClick', middleClick: 'aiMiddleClick',
      rightClick: 'aiRightClick', hover: 'aiHover', longPress: 'aiLongPress',
      input: 'aiInput', clearInput: 'aiClearInput', keyboardPress: 'aiKeyboardPress',
      scroll: 'aiScroll', locate: 'aiLocate', act: 'aiAct', assert: 'aiAssert',
      waitFor: 'aiWaitFor', boolean: 'aiBoolean', query: 'aiQuery', number: 'aiNumber',
      string: 'aiString', ask: 'aiAsk',
    };
    const actual = Object.fromEntries(Object.entries(ACTION_NODES).map(([a, cfg]) => [a, cfg.node]));
    assert.deepEqual(actual, expected);
  });
  it('LOCATING_ACTIONS 与 SEMANTIC_LABEL 恰好覆盖 ACTION_NODES（11 + 8 = 19，互不重叠）', () => {
    const semantic = Object.keys(SEMANTIC_LABEL);
    assert.equal(LOCATING_ACTIONS.size, 11);
    assert.equal(semantic.length, 8);
    assert.deepEqual(
      [...new Set([...LOCATING_ACTIONS, ...semantic])].sort(),
      Object.keys(ACTION_NODES).sort(),
    );
    for (const action of LOCATING_ACTIONS) {
      assert.equal(ACTION_NODES[action]?.xpath, true, `${action} 应支持 xpath`);
      assert.ok(!(action in SEMANTIC_LABEL), `${action} 不应同时出现在语义集合`);
    }
    for (const action of semantic) {
      assert.equal(ACTION_NODES[action]?.xpath, false, `${action} 不应带 xpath`);
      assert.ok(!LOCATING_ACTIONS.has(action), `${action} 不应同时出现在定位集合`);
      assert.equal(typeof SEMANTIC_LABEL[action], 'string');
    }
  });
});