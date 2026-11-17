# 定位控制台（midscene-tests）

基于 [Midscene.js](https://midscenejs.com/zh/) 的 Web UI 自动化控制台。用**自然语言**描述操作，由 AI 视觉模型完成元素定位与交互；并在 AI 之上叠加**显式 XPath** 与**定位缓存**两层，形成「确定性优先、AI 兜底」的三层定位链路。

> 面向普通用户的操作手册见 [使用指南.md](./使用指南.md)。本文档面向开发者与维护者。

---

## 1. 能做什么

| 能力 | 说明 |
|---|---|
| 自然语言驱动 UI | 「在搜索框输入 Markdown」「点击提交按钮」——AI 读截图定位并操作，不依赖 DOM 选择器 |
| 三层定位链路 | 显式 XPath → 定位缓存（prompt→xpath，rect 校验）→ AI 视觉，逐级降级、成功后自动回填缓存 |
| 业务语义复用 | 把多个步骤组合成可命名的语义（如「登录」），用例或其他入口一键调用 |
| 参数驱动 | 步骤文本用 `${name}` 占位；同一语义传多值（`name=1\|2`）自动**逐值执行多轮** |
| 用例库与批量回归 | 保存的用例按分组管理，可勾选批量执行，逐步骤展示定位层级与耗时 |
| 复用真实浏览器登录态 | 三种启动模式：接管真实 Chrome / 独立登录档案 / 全新无痕 |

---

## 2. 快速开始

```powershell
cd C:\dsh-workspace\branch1\midscene-tests

# 1) 首次：安装依赖与浏览器（已安装可跳过）
pnpm install
pnpm exec playwright install chromium

# 2) 配置模型（首次）：把 .env.example 复制为 .env 并填写四项
#    MIDSCENE_MODEL_BASE_URL / _API_KEY / _NAME / _FAMILY

# 3) 启动控制台
pnpm console
```

启动后终端出现**中文引导菜单**：

```
[?] 请选择浏览器模式（直接按回车 = 使用默认项）：
  1) cdp        接管你正在使用的 Chrome（自动复用全部已登录状态；首次会自动启动调试版 Chrome）
  2) persistent 使用独立的登录档案（登录一次，以后自动复用）
  3) fresh      全新无痕环境（不保留任何登录状态） [默认]
  请输入 1 / 2 / 3 后按回车：
```

选择后自动打开操作界面：**http://127.0.0.1:23366**。

---

## 3. 三层定位链路

每次定位按顺序尝试，前一层成功则跳过后续（成本从低到高）：

```
① 显式 XPath        浏览器内解析 + rect 校验        零模型调用
        ↓ 未提供 / 解析失败
② 定位缓存          prompt → xpath，逐条在当前 DOM 重解析
                    元素存在且 rect 有效才命中        零模型调用
        ↓ 未命中 / 校验被拒
③ AI 视觉定位       截图 → 多模态模型 → 坐标         成功后回填缓存（自愈）
```

每次执行在结果卡上标注实际命中的层级：`Tier 1 · 显式 xpath` / `Tier 2 · 缓存命中` / `Tier 3 · AI 视觉` / `AI 语义`。

**缓存位置**：`midscene_run/cache/web-locate-chain.cache.yaml`（与 `pnpm test` 的 YAML 用例共享）。
**禁用缓存**：`MIDSCENE_LOCATE_CACHE=false pnpm console`。

---

## 4. 业务语义与参数

**业务语义** = 多步骤的可复用组合，存于 `console/semantics/<名称>.json`。

- 编辑器里编排步骤 → 点「⚡ 存为语义」
- 在任意步骤的动作下拉「业务语义」分组中选择 `⚡ 名称` 即插入引用
- 右侧语义面板可「▶ 直接运行」/「✎ 加载到编辑器」/「✕ 删除」

**参数语法与 Midscene 官方一致**：

| 写法 | 取值来源 | 说明 |
|---|---|---|
| `${name}` | 用例参数面板 / 语义调用参数 / 步骤行内 | 官方项目变量语法 |
| `${{ENV_NAME}}` | 操作系统环境变量 | 原样保留给 Midscene runner 解析 |

**数据驱动（多轮执行）**：同一参数给多个值，动作不变、取值逐轮替换。

```
name=1|2      → 第 1 轮用 1，第 2 轮用 2（2 轮）
name=1,name=2 → 同上（重复键写法）
```

多参数同时驱动时数量必须一致（`name=1|2, city=北京|上海`），不一致会明确报错。

**参数持久化**：保存用例时，参数写入同名 `.yaml.params.json` sidecar；「✎ 编辑」加载回编辑器时自动回填。多值参数（`a=1|2`）保存时按值逐轮展开为连续原子步骤写入 YAML，回归与官方 runner 会跑完全部值。

---

## 5. 浏览器模式与登录态复用

| 模式 | 行为 | 适用 |
|---|---|---|
| `1) cdp` | 自动启动/接管调试版 Chrome（端口 9222，独立调试档案），操作的就是可见的真实浏览器 | 需要在已登录的系统里操作 |
| `2) persistent` | 使用独立登录档案目录（默认 `%LOCALAPPDATA%\LocateConsoleProfile`） | 登录一次长期复用，但无需看见窗口 |
| `3) fresh` | 全新无痕上下文，不保留任何登录态 | 公开页面、快速验证 |

`cdp` 模式的调试 Chrome 以独立进程运行（不随控制台退出），登录态保存在调试档案中。
手动启动调试 Chrome：`powershell -ExecutionPolicy Bypass -File console\start-chrome-debug.ps1`。

服务启动成功后会**自动打开前端**；重复启动时会提示「服务已在运行」并直接打开前端，不再起第二个实例。

---

## 6. 项目结构

```
midscene-tests/
├── cases/                        测试用例（YAML，按子目录分组；当前为空）
├── console/                      定位控制台
│   ├── server.mjs                服务端：13 个 API + 静态资源（端口 23366）
│   ├── lib.mjs                   纯函数模块（YAML/缓存解析生成，10 个导出）
│   ├── start-chrome-debug.ps1    启动调试版 Chrome（CDP 模式）
│   ├── public/                   前端：index.html / app.js / style.css（零依赖原生实现）
│   ├── semantics/                业务语义（JSON，按名称一文件；当前为空）
│   └── test/                     三套测试：unit / integration / e2e
├── nodes/todo.ts                 自定义业务 Node 示例（TodoMVC 初始化与断言）
├── midscene.config.ts            测试工程配置（Playwright + Midscene Agent + Node 注册）
├── midscene-node-spec.web.md     Node 说明书（pnpm run nodes 生成，36 个 Node）
├── .env / .env.example           模型与运行配置
├── LOCATING.md                   定位链路与缓存机制的详细说明
├── 使用指南.md                    面向普通用户的操作手册
└── README.md / README.zh.md      项目说明（本文）
```

运行产物（`.gitignore` 内，可随时删除）：`midscene_run/`（报告与定位缓存）、`.midscene/`（测试结果）。

---

## 7. 用例与回归

用例是标准 Midscene Test YAML：

```yaml
beforeEach:
  - gotoUrl: https://todomvc.com/examples/react/dist/#/

cases:
  - name: 新增待办并断言
    steps:
      - aiTap: 顶部的新待办输入框
      - aiInput:
          prompt: 顶部的新待办输入框
          value: 买牛奶
      - aiKeyboardPress:
          keyName: Enter
      - aiAssert: 列表中出现了名为「买牛奶」的待办
```

- **保存**：控制台「保存」按钮生成 `cases/<分组>/console-<标题>-<时间戳>.yaml`（保存时语义已展开为原子步骤；多值参数按值逐轮展开为连续步骤、全部值落盘；单值参数替换为字面值，官方 runner 可直接执行）
- **回归**：右侧勾选（单条/整组/全选）→「▶ 回归选中」，逐用例执行、失败即停该用例
- **命令行**：`pnpm test` 运行 `cases/**/*.{yaml,yml}` 全部用例

---

## 8. 测试与验证

| 套件 | 命令 | 规模 | 说明 |
|---|---|---|---|
| 单元 | `node --test console/test/unit.test.mjs` | 56 | `lib.mjs` 纯函数、YAML 往返、`${}`/`${{ENV}}` 保真 |
| 参数逻辑 | `node --test console/test/param-logic.test.mjs` | 9 | app.js 抽取的轮次/保存展开逻辑（vm 沙箱，无需浏览器） |
| 集成 | `node --test console/test/integration.test.mjs` | 43 | 独立实例（端口 23367）全端点契约、路径穿越防护、sidecar 闭环 |
| 流程 E2E | `node console/test/e2e.mjs` | 111 断言 | Playwright 驱动真实 UI（端口 23368），自建自清 fixture |

工具链自检：

```powershell
pnpm exec midscene-test --help        # CLI 可用
pnpm exec midscene-test nodes         # 重新生成 Node 说明书
pnpm exec midscene-test model verify  # 模型四角色连通性
```

---

## 9. 与官方 Midscene Test 的关系

| 层 | 归属 |
|---|---|
| 执行引擎（Agent、三层定位、缓存、`pnpm test`、Node Spec） | **官方机制**，与 Midscene Test 完全一致 |
| 用例 YAML、`${}` / `${{ENV}}` 变量、`beforeEach`/`gotoUrl` | **官方语法** |
| 业务语义（JSON 步骤组合）、数据驱动多轮、控制台 UI | **本项目编排层**，产物最终展开为官方线性 YAML |

> 官方明确不支持 YAML 内循环（[编写 YAML 用例](https://midscenejs.com/zh/midscene-test/writing)：「不引入 DAG、条件分支或循环语法」，建议外部生成线性步骤）。本项目的多值数据驱动即"外部生成线性步骤"的界面化实现：保存时每个参数值展开为该值对应的连续步骤，落盘产物可被官方 runner 一次跑完所有轮次。

---

## 10. 常见问题

**Q：端口 23366 被占用？**
在 `.env` 加 `CONSOLE_PORT=其他端口`；若占用者是本控制台，重复启动会直接打开前端而不是报错。

**Q：选了 cdp 模式却没连上？**
先运行 `console\start-chrome-debug.ps1`（或让程序自动拉起）。若 Chrome 正在运行且没有调试端口，需要先关闭再启动——运行中的实例会吞掉调试参数。

**Q：首次定位很慢？**
Tier 3 走 AI 视觉，通常 3-15 秒。同一 prompt 第二次起命中缓存（Tier 2，约 1 秒）。

**Q：中文提示乱码？**
程序启动时会自动执行 `chcp 65001`。若仍乱码，请使用 Windows Terminal 或 PowerShell 7。

---

## 11. 参考

- Midscene 官网：https://midscenejs.com/zh/
- 编写 YAML 用例：https://midscenejs.com/zh/midscene-test/writing
- 开发自定义 Node：https://midscenejs.com/zh/midscene-test/extend
- 缓存 AI 规划与定位：https://midscenejs.com/zh/caching
