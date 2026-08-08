# 动作参考、骨架与绑定系统计划

> 状态：P2 编辑闭环已完成，真实 provider 验证与服务端持久化未完成；最后更新：2026-08-08。
>
> 本文记录动作一致性方向的产品判断、当前实现、验证方法和后续开发顺序，供换机器或换开发会话后继续推进。API 的已实现字段仍以 [`api.md`](./api.md) 为准。

## 1. 目标与边界

目标是把 AI 动画生成中的「动作结构」从纯 prompt 猜测改为显式条件，使同一个角色在连续帧中更稳定地完成待机、走、跑、攻击、受击、死亡等动作。

骨架主要约束二维姿态和肢体轨迹，不能单独保证脸、服装、配色、武器、披风等外观一致。完整条件应拆为：

1. **角色参考**：回答「谁在演」，约束角色外观；
2. **动作参考**：回答「演什么」，约束姿态、顺序和节奏；
3. **生成配置**：回答「画成什么样」，约束模型、视角、风格、尺寸和布局。

第一阶段不做图片蒙皮或任意骨架绑定。只为生成模型提供动作条件时，标准骨架渲染成姿态图即可；只有动作重定向、角色变形预览和失败帧补位才真正需要角色绑定与 puppet warp。

## 2. 当前已实现：双参考图实验闭环

现有「多动作生成」图片模式支持：

- 第一张图：当前素材，作为角色外观参考；
- 第二张图：从素材库选择的动作参考，可使用骨架表、姿态表、动作截图或已有精灵动作表；
- 文本提示：声明两张图的用途，要求按第二张图的格子顺序和布局生成，且不画出骨架线和关节点。

请求字段：

- `referenceMaterialId` / `referenceFrameId`：角色或普通参考，二选一；
- `poseReferenceMaterialId` / `poseReferenceFrameId`：动作参考，二选一；
- 动作参考不能脱离第一张角色/普通参考单独提交。

当前 provider 行为：

| Provider | 动作参考 | 输入顺序 / 限制 |
| --- | --- | --- |
| DashScope / 百炼 | 已接入 | 角色图 → 动作图 → 文本；具体模型仍需支持多图理解 |
| Gemini | 已接入 | 两个 `inlineData` 后跟文本；具体模型仍需支持图片生成与多图输入 |
| OpenAI 兼容 | 已接入 | 双图使用两个有序的 `image[]`；兼容网关不一定实现该格式 |
| MiniMax | 不支持 | 请求创建时返回 400，避免静默丢弃动作参考 |
| CLI | 不支持 | 尚无独立动作图参数，携带动作参考时返回 400 |
| 视频生成 | 不支持 | 当前视频链路仍只有单参考语义，携带动作参考时返回 400 |

关键实现位置：

- 前端请求类型：`apps/web/src/api.ts` 的 `GenerateBody`；
- 动作参考 UI 与提示词：`apps/web/src/components/ActionGenModal.tsx`；
- 通用素材选择器：`apps/web/src/components/ReferencePicker.tsx`；
- API 校验与任务载荷：`apps/server/src/api/import.ts`、`apps/server/src/api/materials.ts`；
- 引用文件解析和 provider 限制：`apps/server/src/providerAdapter.ts`；
- 任务类型：`apps/server/src/jobs/extract.ts` 的 `GeneratePayload`；
- 厂商多图请求：`apps/server/src/jobs/generateApi.ts`。

当前实现属于**普通多图语义引导**，不是 ControlNet/OpenPose 的强姿态控制。骨架编辑器是否值得投入，必须先用真实模型验证第二张图的服从度。

### 2.1 已实现的动作骨架工作台

`/motions` 已不是旧的 Action 生成入口，而是独立的 `humanoid-v1` 动作编辑系统：

- 固定人形拓扑、根节点平移与逐骨骼局部旋转，使用 FK 作为唯一姿态事实源；
- PixiJS 关节拖拽、视角切换、镜像、重置，以及待机/走/跑/攻击/受击/死亡/跳跃预设；预设来自 Quaternius Universal Animation Library Standard GLB 的 CC0 骨骼动画，每段按动作类型采样为 8–16 帧并重定向为二维局部旋转；
- 关键帧增删复制排序、fps、循环播放和局部旋转插值；
- 512×512 姿态表导出、素材库上传，并注入动作生成弹窗作为独立姿态参考；
- 选择动作预设后立即播放，并可用动作幅度、手臂摆幅、腿部步幅、身体起伏和前倾五个参数调整整段 clip；只有需要精修时才停止播放并逐帧拖动关节。

曾评估直接嵌入成熟 OpenPose 编辑器，但其 COCO-18、JSON、人物分组等专业概念增加了普通用户的操作成本，因此没有保留在主工作流中。参考项目和实际复用边界记录在中英文 README。

## 3. 当前试验方法

### 3.1 准备同一组对照输入

1. 选择一个细节适中的角色素材；
2. 准备一张 8–16 帧动作参考表；
3. 动作参考表的行列、阅读顺序与目标精灵表一致；
4. 每格只放一个清晰姿态，人物大小和中心位置尽量一致；
5. 先测试走路或跑步，再测试持武器攻击；
6. 同一 provider、模型、尺寸和 prompt 分别生成「无动作参考」与「有动作参考」版本。

姿态图不要直接制作成 32×32 或 64×64。应按生成模型的输入尺寸绘制，再在产物入库后切格和下采样。

### 3.2 记录指标

每个模型至少生成 3 组，记录：

- 动作顺序命中率；
- 肢体方向和落脚点错误帧数；
- 角色脸、服装、武器明显漂移帧数；
- 骨架线或参考图元素污染帧数；
- 可直接使用的帧比例；
- 获得一套可用动作所需的重生成次数；
- 洋葱皮校正所需时间。

进入下一阶段的建议门槛：动作参考版本相较纯 prompt，在动作错误帧数或人工校正时间上至少降低约 30%，且外观漂移没有明显恶化。若多图模型经常忽略第二张图，优先接入真正的 pose/control endpoint，而不是先开发骨架 UI。

## 4. 分阶段实施计划

### P0 — 双参考图可行性验证（当前）

- [x] 多动作生成增加独立动作参考选择；
- [x] 前后端贯通 `poseReferenceMaterialId` / `poseReferenceFrameId`；
- [x] DashScope、Gemini、OpenAI 兼容 API 发送有序双图；
- [x] CLI、MiniMax、视频链路显式拒绝，不静默忽略；
- [ ] 按第 3 节完成真实模型 A/B 测试并记录结果；
- [ ] 确定首个可靠的 pose-capable provider / 模型。

### P1 — Provider 能力与强姿态控制

先解决模型协议，再做编辑器：

- 在共享 `GenProvider` / `GenProviderInfo` 中声明动作控制能力，不根据 provider 类型猜测；
- 最低需要表达：是否支持多图、是否支持独立 pose/control image、最大参考图数量、支持的媒体类型；
- `/api/config` 将能力下发前端，`ProviderModelPicker` 只展示可用组合；
- 优先评估 ControlNet OpenPose、Pose Adapter、IP-Adapter + ControlNet 或可配置 ComfyUI 工作流；
- CLI 若接入动作控制，使用结构化 `cliPoseArg`，服务端组 argv，禁止恢复手写 shell 模板；
- 对不兼容模型在提交前提示，而不是等任务执行后失败。

### P2 — 固定人形骨架与动作预设编辑器

确认模型端有效后，先支持 `humanoid-v1`，不立即支持任意拓扑：

- [x] 固定关节：根/骨盆、胸、颈、头、左右肩肘腕、左右髋膝踝；
- [x] Pixi 独立 FK 骨架编辑画布：拖动根/关节、复制姿态、左右镜像、恢复默认；
- [x] 动作时间轴：新增/复制/删除（至少一帧）/左右排序，设置 fps 与循环；
- [x] 播放时对局部旋转与根节点位移线性插值；
- [x] 按时间线渲染 512×512 单元格姿态表，上传素材库后可作为生成动作参考；
- [x] 内置来自 Quaternius Universal Animation Library CC0 动画的 8–16 帧待机、走、跑、攻击、受击、死亡、跳跃预设与 front/back/left/right 视角；
- [x] 预设选择后自动播放，以及作用于完整 clip 的五项高层动作参数；
- [ ] 动作 clip 服务端持久化、IK、约束、缓动、首尾连续性检查；
- [ ] 真实 provider 的姿态服从度 smoke / A/B 验证；
- 生成时优先一次生成 8–16 帧短精灵表，复杂动作拆成多个 clip。

### P3 — 骨架、动作与角色比例解耦

将数据拆为三类独立资产：

1. `SkeletonDefinition`：关节拓扑、父子关系、标准骨长和约束；
2. `MotionClip`：兼容骨架类型、视角、fps、循环、根位移和逐帧局部旋转；
3. `CharacterBinding`：角色参考素材、rest pose、角色骨长比例、关键锚点和附件点。

同一 `MotionClip` 应可重定向到不同身体比例。第一版绑定只标注角色比例和锚点，不切割图片、不计算蒙皮权重。

建议的共享类型方向（实现时再根据交互收敛，不直接照抄）：

```ts
interface MotionClip {
  id: string;
  name: string;
  rigType: "humanoid-v1";
  view: "front" | "back" | "left" | "right" | "three-quarter";
  fps: number;
  loop: boolean;
  frames: Array<{
    root: { x: number; y: number };
    joints: Record<string, {
      rotation: number;
      visible?: boolean;
      depth?: number;
    }>;
  }>;
}
```

动作不应存为每帧绝对屏幕坐标：根节点保存整体位移，动作保存局部旋转，骨长来自骨架或角色绑定。`view` 必须是结构化字段，不能只写进 prompt。

### P4 — 自定义骨架与双向利用（远期）

- 自定义关节拓扑和动作兼容映射；
- 四足、尾巴、翅膀、多足和机械结构；
- 从图片或视频估计初始姿态；
- 图片切片、mesh、蒙皮权重和 puppet warp 预览；
- AI 失败帧使用变形结果临时补位；
- 武器、披风、裙摆等附件点/自由跟随点。

该阶段复杂度显著高于生成条件图，必须由前面阶段的真实使用需求驱动。

## 5. 数据与模块边界

- 骨架和关节数据不得写入现有 `Frame.offset_x/y`、`rotation`、`scale`、`opacity`；这些字段只表示整张图片的统一帧变换；
- 不把长期骨架结构塞入 `Frame.metadata` 或 `Material.metadata`；验证通过后使用独立表和共享类型；
- 动作模板应是可跨项目复用资产，项目只保存引用或生成后的帧；
- 姿态图是可再生成的派生产物，源骨架/动作数据才是事实源；
- provider-specific 请求格式留在 `apps/server/src/jobs/generateApi.ts` 或独立 adapter，不泄漏到前端数据模型；
- 任务依赖继续保持 `queue.ts` → `jobs/*` 单向；
- 若为骨架资产增加文件夹，需同步扩展共享 `FolderKind`、服务端文件夹资源映射和前端 `FolderTree`，不要伪装成普通 material folder。

初步持久化候选：

- `skeletons`：骨架定义；
- `motion_clips`：动作基本信息和关键帧 JSON；
- `character_bindings`：骨架 × 角色素材的比例和锚点；
- 大量关键帧或需要局部更新时，再考虑拆出 `motion_keyframes`。

P2 初期可只用设置表或单个 JSON 验证交互，但进入可复用资产阶段前必须迁移为正式表，不能长期依赖浏览器 localStorage。

## 6. 验收标准

### P1 验收

- UI 能准确区分普通多图理解与真正 pose/control 能力；
- 不支持的 provider/model 无法提交动作参考任务；
- 至少一个后端能稳定接受角色参考和动作条件；
- 同一测试集相较纯 prompt 达到第 3.2 节的收益门槛。

### P2 验收

- 用户可从内置动作开始，拖动关节并编辑 8–16 帧动作；
- 导出的姿态表格子顺序、行列和生成请求一致；
- 正面、背面、左右视角不会误复用；
- 动作编辑、生成、网格切分、抠图和项目导入形成完整闭环；
- `bun run typecheck` 通过，并完成一次真实 provider 冒烟。

### P3 验收

- 同一人形动作可应用到至少两种明显不同的角色比例；
- 动作资产与角色绑定可以独立保存、复制和删除；
- 删除被引用资产时有明确引用检查或解除策略；
- 现有帧编辑、预览和导出几何语义不受影响。

## 7. 跨机器继续开发清单

1. 拉取代码并执行 `bun install`；
2. 配置至少一个支持图片生成和多图输入的 DashScope、Gemini 或 OpenAI 兼容 provider；
3. 执行 `bun run typecheck`，确认基线通过；
4. 根据第 3 节准备角色图和动作表，先完成 P0 A/B 测试；
5. 把测试所用 provider、模型、尺寸、输入图、成功率和失败模式补充到本文；
6. 若第二张图服从度不足，直接进入 P1 接强姿态协议，不要先做 P2 UI；
7. 若效果达到门槛，从 P2 的固定 `humanoid-v1` 开始，不先做任意骨架；
8. API 字段变化同步 `docs/api.md`，架构或目录变化同步 `docs/architecture.md` 和 `AGENTS.md`；
9. 完成改动后至少运行 `bun run typecheck`；真实生成冒烟会产生费用，执行前确认 provider 与模型。

## 8. 已知风险与待决策项

- OpenAI 兼容网关对 `image[]` 的实现不统一，可能需要 provider 级 multipart 字段配置；
- DashScope/Gemini 能接收多图不等于能严格遵循姿态，需要以具体模型实测；
- 整表生成外观通常更一致，但姿态控制可能弱于逐帧生成；后续需保留两种策略的实验空间；
- 逐帧生成可精确控制姿态，但角色外观可能漂移，需要 subject reference、IP-Adapter、LoRA、固定 seed 或后处理配合；
- 低分辨率姿态信息不足，应高分辨率生成后再像素化，不把骨架直接压到最终精灵尺寸；
- 武器、披风、裙摆不是刚性人体骨架能完整约束的内容，后续可能需要附件点或人工洋葱皮校正；
- 任意骨架的动作重定向规则尚未确定，在固定人形方案验证前不要冻结通用 schema。
