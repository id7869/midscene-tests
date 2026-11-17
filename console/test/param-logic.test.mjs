/**
 * app.js 参数逻辑单元测试（node:test + node:vm）
 *
 * console/public/app.js 是 classic script，无法 import；这里从源码的
 * `#region param-logic` 标记之间原样抽取纯函数，在独立 vm 沙箱中执行，
 * 不重复实现被测逻辑（改实现即改被测对象）。
 *
 * 覆盖的回归点：
 *   - 多值参数（k=v1|v2）逐值一轮；
 *   - 保存路径落盘「所有值」（修复前只保存首值）；
 *   - 保存后回读的字面值用例不再重复轮次；
 *   - 同名重复行合并（修复前后行覆盖前行）；
 *   - 多值参数数量不一致时保存/运行都会报错；
 *   - 语义调用参数（v1|v2）与语义模板中的用例参数轮次；
 *   - ${{ENV}} 环境变量不计入用例参数。
 *
 * 运行（项目根）：node --test console/test/param-logic.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const APP_PATH = fileURLToPath(new URL('../public/app.js', import.meta.url));
const SOURCE = readFileSync(APP_PATH, 'utf8');

// vm 沙箱的对象来自另一个 realm，原型不同；比较前转成本 realm 的普通值
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadParamLogic() {
  const match = SOURCE.match(/\/\/ #region param-logic\r?\n([\s\S]*?)\/\/ #endregion param-logic/);
  assert.ok(match, 'console/public/app.js 必须保留 #region param-logic / #endregion param-logic 标记');
  const code = `
let caseData = { title: '', steps: [], params: [] };
${match[1]}
globalThis.__paramLogic = {
  subst, extractParams, unresolvedParams, parseKv,
  expandSteps, expandParamRounds, flattenRounds, caseParamsObj,
  referencedParamKeys, effectiveCaseParams, expandCaseRounds,
  setCaseData: (data) => { caseData = data; },
  setSemantics: (items) => { semantics = items; },
};
`;
  const context = { console, JSON, Set, Object, Array, String, Number, RegExp, Math, Date };
  runInNewContext(code, context);
  assert.ok(context.__paramLogic, '参数逻辑抽取执行失败');
  return context.__paramLogic;
}

const logic = loadParamLogic();
const inputStep = (over = {}) => ({
  action: 'input', prompt: '输入 ${name}', xpath: '', value: '${name}', ...over,
});

describe('参数值轮次（expandCaseRounds）', () => {
  it('name=1|2 逐值一轮，每轮只含该值', () => {
    logic.setSemantics([]);
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '1|2' }] });
    const rounds = logic.expandCaseRounds([inputStep()]);
    assert.equal(rounds.length, 2);
    assert.deepEqual(plain(rounds.map((r) => r[0].value)), ['1', '2']);
    assert.deepEqual(plain(rounds.map((r) => r[0].prompt)), ['输入 1', '输入 2']);
  });

  it('保存路径展开所有值（回归：修复前只保存首值）', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '1|2' }] });
    const saved = logic.flattenRounds(logic.expandCaseRounds([inputStep()]));
    assert.deepEqual(plain(saved.map((s) => s.value)), ['1', '2']);
    assert.deepEqual(plain(saved.map((s) => s.prompt)), ['输入 1', '输入 2']);
  });

  it('重复键写法（同名两行）合并为多值轮次，不再后行覆盖前行', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '甲' }, { k: 'name', v: '乙' }] });
    assert.deepEqual(plain(logic.caseParamsObj()), { name: ['甲', '乙'] });
    assert.deepEqual(plain(logic.expandCaseRounds([inputStep()]).map((r) => r[0].value)), ['甲', '乙']);
  });

  it('未被步骤引用的参数不制造轮次（保存后回读的字面值用例）', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '1|2' }] });
    const literal = inputStep({ prompt: '输入 1', value: '1' });
    assert.equal(logic.expandCaseRounds([literal]).length, 1);
    assert.deepEqual(plain(logic.flattenRounds(logic.expandCaseRounds([literal])).map((s) => s.value)), ['1']);
  });

  it('被引用的多值参数数量不一致 → 报错（保存路径同样被拦截）', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'a', v: '1|2' }, { k: 'b', v: '3|4|5' }] });
    const step = { action: 'input', prompt: '${a}-${b}', xpath: '', value: '' };
    assert.throws(() => logic.expandCaseRounds([step]), /多值参数数量不一致/);
  });

  it('空值仍保留占位符，展开结果可被保存校验拦截', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '' }] });
    const expanded = logic.flattenRounds(logic.expandCaseRounds([inputStep()]));
    assert.deepEqual(plain(logic.unresolvedParams(expanded[0].prompt)), ['name']);
  });

  it('${{ENV}} 环境变量不计入用例参数，也不产生轮次', () => {
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'name', v: '1|2' }] });
    const step = { action: 'tap', prompt: '打开 ${{BASE_URL}} 页面', xpath: '', value: '' };
    assert.equal(logic.referencedParamKeys([step]).size, 0);
    assert.equal(logic.expandCaseRounds([step]).length, 1);
  });
});

describe('语义调用参数轮次', () => {
  it('语义模板形参由调用参数多值驱动：逐值一轮，保存时全部展开', () => {
    logic.setSemantics([{
      name: '输入账号',
      steps: [{ action: 'input', prompt: '账号 ${u}', xpath: '', value: '' }],
    }]);
    logic.setCaseData({ title: 't', steps: [], params: [] });
    const semStep = { action: 'sem:输入账号', prompt: '', xpath: '', value: 'u=甲|乙' };
    const rounds = logic.expandCaseRounds([semStep]);
    assert.equal(rounds.length, 2);
    assert.deepEqual(plain(rounds.map((r) => r[0].prompt)), ['账号 甲', '账号 乙']);
    assert.deepEqual(plain(logic.flattenRounds(rounds).map((s) => s.prompt)), ['账号 甲', '账号 乙']);
  });

  it('语义模板引用用例参数时，用例参数轮次仍然生效', () => {
    logic.setSemantics([{
      name: '登录',
      steps: [{ action: 'input', prompt: '账号 ${u} @ ${city}', xpath: '', value: '' }],
    }]);
    logic.setCaseData({ title: 't', steps: [], params: [{ k: 'city', v: '北京|上海' }] });
    const semStep = { action: 'sem:登录', prompt: '', xpath: '', value: 'u=甲' };
    const rounds = logic.expandCaseRounds([semStep]);
    assert.equal(rounds.length, 2);
    assert.deepEqual(plain(rounds.map((r) => r[0].prompt)), ['账号 甲 @ 北京', '账号 甲 @ 上海']);
  });
});
