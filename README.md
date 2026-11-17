# Locate Console (midscene-tests)

A Web UI automation console built on [Midscene.js](https://midscenejs.com/). Describe actions in natural language; a vision model locates elements and drives the browser. On top of AI, an explicit-XPath layer and a locate cache form a **three-tier locating chain** (deterministic first, AI as fallback).

> Chinese docs: [README.zh.md](./README.zh.md) · End-user guide (Chinese): [使用指南.md](./使用指南.md)

---

## Quick start

```powershell
cd C:\dsh-workspace\branch1\midscene-tests
pnpm install                                  # once
pnpm exec playwright install chromium         # once

# configure model: copy .env.example -> .env and fill 4 keys
#   MIDSCENE_MODEL_BASE_URL / _API_KEY / _NAME / _FAMILY

pnpm console
```

On start you get an interactive menu (Chinese UI):

```
[?] 请选择浏览器模式（直接按回车 = 使用默认项）：
  1) cdp        接管你正在使用的 Chrome（自动复用全部已登录状态；首次会自动启动调试版 Chrome）
  2) persistent 使用独立的登录档案（登录一次，以后自动复用）
  3) fresh      全新无痕环境（不保留任何登录状态） [默认]
```

The console then opens at **http://127.0.0.1:23366**.

---

## Three-tier locating chain

```
1. explicit XPath    parsed in browser + rect validated      (no model call)
        ↓ missing / invalid
2. locate cache      prompt -> xpaths, re-resolved on live DOM
                     element must exist with a valid rect     (no model call)
        ↓ miss / rejected
3. AI visual locate  screenshot -> multimodal model -> point  (backfills cache)
```

Each result card shows the tier that served it: `Tier 1 · explicit xpath` / `Tier 2 · cache hit` / `Tier 3 · AI visual` / `AI semantic`.

Cache file: `midscene_run/cache/web-locate-chain.cache.yaml` (shared with the YAML test suite).
Disable caching: `MIDSCENE_LOCATE_CACHE=false pnpm console`.

---

## Business semantics & parameters

**Business semantics** = named, reusable multi-step groups stored in `console/semantics/<name>.json`.
Compose steps in the editor → "⚡ 存为语义"; call them from any step's action dropdown (`⚡ name`) or run them directly from the right-hand panel.

Parameter syntax matches Midscene's official variables:

| Syntax | Source |
|---|---|
| `${name}` | case parameter panel / semantic call args / step-row args |
| `${{ENV_NAME}}` | OS environment variables (passed through to the Midscene runner) |

**Data-driven rounds**: give one parameter several values and the same actions run once per value.

```
name=1|2          -> round 1 uses "1", round 2 uses "2"
name=1,name=2     -> same (repeated-key form)
```

Multiple data-driven parameters must have equal value counts, otherwise a clear error is raised.
Parameters persist next to the case file as `<case>.yaml.params.json` and are restored when editing.
Saving expands every value of a multi-value parameter into consecutive linear steps, so the saved YAML (and regression / `pnpm test`) covers all rounds.

---

## Browser modes

| Mode | Behaviour | Use when |
|---|---|---|
| `cdp` | Auto-launches/attaches a debug Chrome on port 9222 with a dedicated profile | You need the site you're already logged into |
| `persistent` | Persistent profile at `%LOCALAPPDATA%\LocateConsoleProfile` | Log in once, reuse silently |
| `fresh` | Clean incognito context | Public pages, quick checks |

Debug Chrome runs as an independent process and keeps its login state. Manual launcher:
`powershell -ExecutionPolicy Bypass -File console\start-chrome-debug.ps1`.

Starting a second instance detects the running server, opens the frontend, and exits gracefully instead of throwing `EADDRINUSE`.

---

## Project layout

```
cases/                        test cases (YAML, grouped by subdirectory)
console/
  server.mjs                  13 APIs + static assets (port 23366)
  lib.mjs                     pure helpers (YAML/cache parse & build, 10 exports)
  start-chrome-debug.ps1      launcher for CDP debug Chrome
  public/                     frontend (index.html / app.js / style.css, zero deps)
  semantics/                  business semantics (JSON, one file per name)
  test/                       unit / integration / e2e suites
nodes/todo.ts                 example custom business Node (TodoMVC helpers)
midscene.config.ts            test project config (Playwright + Midscene Agent + nodes)
midscene-node-spec.web.md     generated Node spec (36 nodes)
LOCATING.md                   locating chain & cache details
```

Runtime artifacts (gitignored): `midscene_run/` (reports, locate cache), `.midscene/` (test results).

---

## Cases & regression

Cases are standard Midscene Test YAML (`beforeEach: gotoUrl` + `cases[].steps`).

- Saving from the console writes `cases/<group>/console-<title>-<ts>.yaml` with semantics expanded and parameters substituted; each value of a multi-value parameter becomes its own consecutive steps — directly runnable by the official runner.
- Regression: select files (single / whole group / all) → "▶ 回归选中"; each case runs independently and stops at its first failing step.
- CLI: `pnpm test` runs every `cases/**/*.{yaml,yml}`.

---

## Tests

| Suite | Command | Size |
|---|---|---|
| Unit | `node --test console/test/unit.test.mjs` | 56 tests |
| Param logic | `node --test console/test/param-logic.test.mjs` | 9 tests (app.js param rounds via vm) |
| Integration | `node --test console/test/integration.test.mjs` | 43 tests (isolated server on 23367) |
| E2E | `node console/test/e2e.mjs` | 111 assertions (Playwright on 23368) |

Toolchain checks: `pnpm exec midscene-test --help | nodes | model verify`.

---

## Relationship with official Midscene Test

The execution engine (Agent, three-tier locating, caching, `pnpm test`, Node Spec) and the case YAML / `${}` / `${{ENV}}` syntax are **official Midscene mechanisms**. The business-semantics JSON groups, data-driven rounds and the console UI are a **project-level orchestration layer** whose output is plain linear official YAML.

Official docs state YAML has no loop/branch syntax and recommends generating linear steps externally; the console's multi-value rounds are the UI form of that recommendation.

---

## References

- Midscene docs: https://midscenejs.com/
- Writing YAML cases: https://midscenejs.com/midscene-test/writing
- Custom nodes: https://midscenejs.com/midscene-test/extend
- Caching: https://midscenejs.com/caching