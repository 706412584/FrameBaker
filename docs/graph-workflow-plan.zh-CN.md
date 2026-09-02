# 无限画布节点工作流 — 实施计划

## 目标 / 非目标

**目标**：在 FrameBaker 内新增「无限画布 + 节点连线」视图，把资产生产链路（视频抽帧 → 抠图 → 像素量化 → UI 切片 → 导出）变成可连线、可增量重跑的 DAG。

**非目标**：
- 不做游戏逻辑蓝图（节点 ≠ 事件/条件/行为，不需要每帧求值与运行时状态）。
- 不合并两个仓库。sprite 只迁移三项能力（视频抽帧流程、像素量化、UI 切片），且只迁算法函数，不迁 React 组件与 store。
- 不替换 FrameBaker 现有编辑器。timeline 轨道×步骤、骨骼项目、攻击特效、逐帧变换属于**人工编排**，与 DAG 正交，保持独立视图。

节点图与 timeline 的接缝：节点图产出的帧落进素材库，再由 timeline 编排。

## 为什么做（依据，非推测）

1. **两个项目各自写过一次"假工作流"**。sprite 的 `WorkflowPanel.tsx:9-15` 是硬编码 5 步 stepper，步骤完成状态靠猜 store 里有没有对应对象（`:23,30-36`）；FrameBaker 的 `queue.ts:126-137` 是硬编码 2 步链（生成角色图 → 自动排队拆件）。需求真实存在，但两次都用了最土的绕法。
2. **sprite 的 `ProcessSettings` 就是一张被压平成单对象的节点图**。`src/types/sprite.ts:175-215` 有 40+ 平铺字段，按归属可直接切成抽帧 / 裁剪 / 画布归一 / 6 个原子抠图 / 边缘净化 / 3 个后处理。`matte_pipeline: AtomicKeyingMode[]`（`:212`）已经是一条线性 pipeline，由 `server.py:1559` 的 `apply_matte_pipeline` 顺序执行 —— 只是没有图结构、没有中间产物、改一个参数全链重跑。
3. **FrameBaker 已有可复用的三块地基**：真队列（`queue.ts:139-222`，并发可配 + AbortController 取消 + WS 进度广播）、OffscreenCanvas worker 模式（`apps/web/src/imageops/`，`app.ts:227-236` 按需 `Bun.build` 同源下发）、约 50 个 MCP tool（`apps/server/src/mcp/tools/`，其 Zod schema 可直接生成节点端口定义）。

## 技术选型（已定）

| 项 | 选择 | 理由 |
| --- | --- | --- |
| 画布 | `@xyflow/react` 12.11.6（React Flow，MIT，38.2k★） | 许可干净；只做画布不绑执行引擎；peer 只要 react ≥17，自带 zustand/classcat，无重依赖 |
| 执行后端 | FrameBaker 现有 Elysia + bun:sqlite + `queue.ts` | 复用队列/取消/WS，不新引框架 |
| 节点定义源 | MCP tool 的 Zod inputSchema | 入参即输入端口，返回即输出端口，省掉大半手工定义 |
| 客户端算法执行位 | `apps/web/src/imageops/` worker | 既有已验证模式，非新决策 |

tldraw 已排除：其 LICENSE 明确禁止生产环境使用（`Not to use the Software in Production Environments`），需购买 License Key。

## 架构

### 新增目录（不动现有目录）

```
apps/server/src/graph/        # 拓扑执行器、节点注册表、内容寻址
apps/web/src/graph/           # React Flow 画布、节点组件、参数面板
packages/shared/src/graph.ts  # 端口类型、节点 schema、图/运行状态枚举
```

依赖方向沿用既有约束：`graph/executor` → `jobs/*` 单向；节点实现不得反向 import 执行器。

### 数据模型（四张表）

按 `db.ts` 既有风格写在同一 `db.exec` 块，存量库补列走 `ensureColumn`。

```sql
CREATE TABLE IF NOT EXISTS graphs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_nodes (
  id TEXT PRIMARY KEY, graph_id TEXT NOT NULL, type TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}', x REAL NOT NULL, y REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_edges (
  id TEXT PRIMARY KEY, graph_id TEXT NOT NULL,
  from_node TEXT NOT NULL, from_port TEXT NOT NULL,
  to_node TEXT NOT NULL, to_port TEXT NOT NULL,
  UNIQUE(to_node, to_port)
);
CREATE TABLE IF NOT EXISTS graph_outputs (
  content_hash TEXT NOT NULL, port TEXT NOT NULL,
  node_type TEXT NOT NULL, payload TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY (content_hash, port)
);
```

`graph_edges` 的 `UNIQUE(to_node, to_port)` 强制单输入端口只能接一条边，避免执行期歧义。

`graph_outputs` 以 `content_hash` 为主键而非 `node_id` —— 这样同参数的节点跨图共享缓存，删节点不失效产物。`payload` 存 JSON（帧 id 数组 / 文件路径 / rect 数组等），不存二进制；实际文件仍落 `STORAGE_ROOT`。

### 内容寻址与增量重跑

```
content_hash = sha256(node_type + canonical_json(params) + 上游各输入端口 hash 按端口名排序拼接)
```

源节点（如 `material.video`）的 hash 用素材文件的 size+mtime，避免整文件哈希开销。

执行前查 `graph_outputs`，命中即跳过。**这是整个设计的承重墙**：没有它，改一个参数会全链重跑，节点图会比现有 stepper 更难用，你会立刻退回旧界面。任何"先跑通再加缓存"的顺序调整都会导致阶段 1 的验收失去意义。

### 端口类型

保持最小集，连线时做类型校验：`video` | `image` | `image[]` | `rect[]` | `sheet` | `palette`。

不做泛型、不做隐式转换。类型不匹配直接拒绝连线。

## 节点清单（v1）

| 节点 | 输入 → 输出 | 执行位 | 复用 |
| --- | --- | --- | --- |
| `material.video` | — → `video` | 服务端 | `materials` 表 |
| `extract.frames` | `video` → `image[]` | 服务端 | `extract_frames` job（`extract.ts:156-174`）|
| `matte.batch` | `image[]` → `image[]` | 服务端 | `matting` job（`matting.ts:86`）|
| `export.spritesheet` | `image[]` → `sheet` | 客户端 | `export.ts:117,149` |
| `matte.chroma` 等 6 个原子 | `image[]` → `image[]` | 服务端 Python | `apply_matte_pipeline`（`server.py:1559`）|
| `image.decontaminate` | `image[]` → `image[]` | 服务端 Python | 同上 |
| `quantize.pixel` | `image` → `image` + `palette` | 客户端 worker | `quantizeEngine.ts:135,148` |
| `slice.ui.analyze` | `image` → `rect[]` | 客户端 worker | `uiSmartSlice.ts:62` |
| `slice.ui.crop` | `image` + `rect[]` → `image[]` | 客户端 worker | `uiSmartSlice.ts:310` |

## 分阶段实施

### 阶段 0 · 契约（无功能代码）

四张表 DDL + `packages/shared/src/graph.ts` 类型 + 节点注册表骨架 + 从 MCP tool schema 生成端口定义的转换器。

验收：`bun run typecheck` 通过；新建空图能存取；hash 函数有单测（同参同 hash、参数顺序无关、上游变则变）。

### 阶段 1 · 最窄真链路

```
material.video → extract.frames → matte.batch → export.spritesheet
```

四个节点全部复用现有能力，只新写：React Flow 画布、拓扑执行器、缓存命中判定、WS 进度回填到节点。

**这一步不碰 sprite。** 目的是验证架构，不是堆功能。

验收：一段视频跑完得到精灵表；改 `export.spritesheet` 参数重跑，前三个节点全部缓存命中（日志可见）；执行中取消能中断当前节点；重启服务后已完成节点仍命中缓存。

### 阶段 2 · 抠图 pipeline 节点化

给 sprite Python 加 argparse CLI 入口（薄壳，复用 `apply_matte_pipeline`），按 FrameBaker 的 `MattingSettings` 结构化 CLI 字段（`types.ts:360-371`）挂成 matting provider —— 不改 FrameBaker 抠图代码。然后把 6 种原子抠图拆成 6 个可串联节点。

第一个真实收益点：任意组合抠图链、每步产物可见、改末尾一步不重跑前面。

验收：`chroma → birefnet → luma` 三节点串联结果与 sprite 里 `matte_pipeline: ["chroma","birefnet","luma"]` 逐像素一致（这是**必须**的等价性验证，否则等于悄悄改了抠图行为）。

**实施修正（2026-09-02）**：等价性验证发现 sprite 的管线语义是「每步在**原图**上算 alpha、`ImageChops.lighter` 并集合并、末尾统一应用 + despill + decontaminate」（`server.py:1727`）——**不是**逐步顺序应用。逐个原子节点串联（每步吃上一步的成品图）无法复现这个语义。因此：
- 新增 `matte.pipeline` 组合节点：单次 CLI 调用承载完整管线（`--pipeline chroma,luma`），与 sprite 语义完全一致，**已验证逐像素一致**（chroma+luma 组合 0 差异）。
- 6 个 `matte.X` 原子节点保留，定位为「单步独立使用」（例如只跑一次色键）；它们的串联是顺序应用语义，与 sprite 管线不同，属预期行为。
- sprite 抠图配置走独立 settings key `spriteMatting`（pythonBin + cliPath），不动全局 rembg matting 设置 —— `matte.batch`（rembg）与 `matte.pipeline`（sprite）共存。

### 阶段 3 · 像素量化节点

`quantizeImageData` / `quantizeImageDataWithPalette` 核心逻辑不动，`document.createElement("canvas")`（`quantizeEngine.ts:70,75,113,118,173`）换 `OffscreenCanvas`，`loadImageToCanvas` 的 `new Image()` 换 `createImageBitmap`，挂进 `imageops` worker。新增 `image-q` 依赖。

验收：同参数下与 sprite 输出逐像素一致；worker 不可用时按既有模式降级主线程。

### 阶段 4 · UI 切片节点 + 人在环

**迁移时必须去重**：`ops.ts` 已有 `detectOpaqueComponents`，`uiSmartSlice.ts:86` 有自己的 `detectComponents`。复用 `ops.ts` 那套，不搬第二份连通域检测进来。`uiSmartSlice.ts:358-373,423` 的 `download*` 不迁（产物落库）。

同时引入 `waiting-for-input` 节点状态：切片节点算出候选框后暂停，在画布上直接开小窗调框，确认后继续下游。这是无限画布相对 stepper 的真正优势，也让 `MattingRefineModal` 那类交互后续有处可去。

验收：候选框结果与 sprite 一致；暂停态可持久化（重启后仍在等待，不丢已算出的候选框）。

**实施结果（2026-09-02，全部通过）**：
- `graph/uiSlice.ts` 迁移：连通域抽为 `ops.ts` 的 `connectedComponentsOnMask` 单份实现（`detectOpaqueComponents` 重构为复用它，行为不变）；与 sprite 逐值等价（候选框坐标/面积/置信度/命名完全一致）。
- 客户端节点执行通道支持两类：产物型（quantize / slice.crop 上传 PNG）与分析型（slice.analyze 直接回 rect JSON，不走文件）。
- 人在环：`slice.ui.analyze` 的 `interactive` 参数开启后，分析完成即暂停（executor 挂起等待，画布右上弹候选框调整面板：x/y/w/h 数字输入、逐框删除、确认继续）；人工调整随确认写入 `graph_outputs`（content_hash 不变 → 重启后重跑缓存命中，调整不丢）。E2E 验证：w 32→20 人工调整 → crop 按调整后的 20x20 切片。

## 已知坑（实施前必须知道）

1. **job payload 只存内存**。`queue.ts:17-18` 明确不落库，`:37` 启动时把遗留 queued/running 全标记 error。节点执行的 payload 必须落 SQLite，否则重启断在半路。阶段 1 就要解决。
2. **sprite 的 `store.ts` 不要适配**。930 行里 `upload`/`preview`/`job`/`exportResult` 各只有一份（`store.ts:144-155`），并行跑多节点会互相踩。做法是只迁纯算法函数，React 组件与 store 全部不迁。
3. **测试基线已有 3 个失败**，与本计划无关：`server-runtime.test.ts` 的两条和 `生成适配器校验` 一条，均因测试写死 `/bin/sh` 在 Windows 上 ENOENT。基线是 `190 pass / 3 fail`，不要误判为自己引入的回归。
4. **文档同步是硬约定**。`AGENTS.md:47-48` 要求改 API 同步 `docs/api.md` + `docs/api.zh-CN.md`，改架构同步 `docs/architecture*.md` + `AGENTS.md`，加 API 功能同步 MCP tool。每阶段末尾都要做。
5. **无测试框架的验证方式**：`AGENTS.md:30` 说明验证 = typecheck + curl smoke。但 `tests/` 下实际有 25 个 `bun test` 文件（`AGENTS.md` 此处已过期）。新增逻辑按 `tests/` 既有风格补测。

## 每阶段共同验收项

- `bun run typecheck` 通过（`tsc -p apps/server && tsc -p apps/web`）。
- `bun test tests` 不引入新失败（基线 190 pass / 3 fail）。
- 用户可见文案走 `i18n.ts` 的 `t()`，中文为字典 key，同步 `apps/web/src/i18n/en.ts`。
- 无硬编码颜色，走 `styles.css` CSS 变量。
- 不用 `alert/confirm/prompt`，走 `notice.ts` 的 `notify()` / `askConfirm()`。
- smoke 测试后清理 `storage/` 与临时文件。
- 不执行任何 git 操作（`AGENTS.md:34`）。

## 建议决策点

阶段 0 + 1 跑通后暂停评估。届时对"节点化是否真的好用"会有实感，比现在纸上判断准。若阶段 1 的缓存命中体验不达预期，应停下重新设计寻址方案，而非继续往上堆节点。

