# 健壮定位链：显式 xpath → 定位缓存 → AI 视觉定位

本工程的 Web 定位按三层优先级解析，确定性递增、成本递减者优先，AI 视觉兜底。
已在本工程实测闭环（`cases/locate-chain.yaml`）。

## 三层链路（源码实证 @midscene v1.17.4）

```
YAML 定位节点 (aiTap / aiInput / aiHover / aiLocate … 共 13 个节点)
   │
   ├─ Tier 0  规划直给（aiAct 内部命中的元素，无独立 locate）
   │
   ├─ Tier 1  显式 xpath 参数
   │          options.xpath → 浏览器内解析 + rect 校验
   │          命中：跳过缓存与 AI，零模型调用
   │
   ├─ Tier 2  定位缓存（prompt → xpaths）
   │          matchLocateCache(prompt) → 逐条 xpath 在当前 DOM 重解析
   │          校验：元素存在且 rect 有效才命中
   │          失效：拒绝该条，继续尝试其余候选 / 落入 Tier 3
   │
   ├─ Tier 3  AI 视觉定位
   │          截图 → 多模态模型返回坐标 → 执行
   │          成功后 point → xpaths 回填缓存（自愈）
   │
   └─ 执行：坐标 → Playwright mouse/keyboard（底层 CDP）
```

编排位置：`@midscene/core/dist/es/agent/task-builder.mjs`（locate 任务，
264–343 行）；rect 校验：`@midscene/web` `base-page.mjs` 的
`rectMatchesCacheFeature` / `cacheFeatureForPoint`。

## 本工程配置（midscene.config.ts）

```ts
new PlaywrightAgent(page, {
  cache:
    process.env.MIDSCENE_LOCATE_CACHE === 'false'
      ? false
      : { id: 'web-locate-chain' },   // 缓存文件: midscene_run/cache/web-locate-chain.cache.yaml
});
```

- 默认读写模式（read-write）：命中即用，新结果自动落盘。
- 调试/强制全 AI：`MIDSCENE_LOCATE_CACHE=false pnpm test`。
- 缓存 id 按工程/页面域隔离，避免不同页面的同名词 prompt 串缓存。

## YAML 用法

```yaml
# Tier 1：显式 xpath（零 AI，结构变化敏感）
- aiTap:
    prompt: the mark-all-as-complete toggle arrow
    options:
      xpath: '//label[@for="toggle-all"]'

# Tier 2/3：纯 prompt（首次 AI 并缓存，之后跨运行命中缓存）
- aiTap:
    prompt: the mark-all-as-complete toggle arrow

# 按节点关闭缓存回填（如目标结构频繁变化，缓存无收益）
- aiTap:
    prompt: some highly dynamic element
    options:
      cacheable: false
```

注意：`xpath` 位于 `options` 内，不是节点顶层键（schema `additionalProperties: false` 严格校验）。

## 缓存机制要点（实测）

1. **复用窗口是跨运行**：同一次运行内新追加的缓存记录不参与匹配
   （`matchCache` 只扫描从文件加载的原始记录）；缓存收益从第二次运行开始。
2. **校验即健壮**：命中要求缓存 xpath 在当前 DOM 重解析出有效 rect。
   透明元素（opacity:0，有布局盒）可通过；`display:none`（无 rect）被拒绝。
3. **失效自愈**：缓存失效 → AI 回退 → 新 xpath 作为新记录回填；失效旧记录
   保留，下次运行多候选逐条校验（旧失效 → 新命中），无需人工清理。
4. **查询类永不缓存**：aiAssert / aiQuery / aiBoolean 每次走模型（语义结果
   不可复用）；规划类（aiAct flow）另有独立缓存。

## 实测数据（cases/locate-chain.yaml，TodoMVC）

| 轮次 | 缓存状态 | 模型调用 | 耗时 | 验证点 |
|---|---|---|---|---|
| 1 首跑 | 无文件 → 追加 3 条 | 有（Tier2a AI） | 40.4s | Tier1 xpath 直连 + 首轮 AI 建缓存 |
| 2 复跑 | 文件 3 条加载 | **0** | 6.8s | 跨运行命中：Tier2a/2b 全缓存服务 |
| 3 注入失效 | hidden input 抢占位置索引 | **恰好 1** | 12.0s | 校验拒绝失效 xpath → AI 回退 → 回填 input[2] |
| 4 自愈 | input[2] 有效 | **0** | 6.2s | 多候选逐条校验，链路回到零 AI |

## 工程建议

- **稳定结构的目标**（登录框、导航、固定按钮）：优先显式 xpath（Tier 1），
  完全确定性、零成本。
- **稳定 prompt + 缓存**（回归套件重复跑的页面）：纯 prompt + 读写缓存，
  第二轮起免 AI，速度提升约 6 倍（40.4s → 6.8s）。
- **动态/多变目标**：纯 prompt + `cacheable: false`（或接受失效自动回退），
  让 AI 兜底。
- 位置型 xpath（`/…/input[1]`）对 DOM 插入敏感——这正是缓存校验层存在的
  价值：失效即拒绝、回退 AI、自动回填新候选。
