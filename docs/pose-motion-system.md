# 通用动画资产与骨骼工作流规范

> 状态：架构基线、核心资产、独立 schema 与 `.fbanim` v1 逻辑包已实现，正式持久化与资产 UI 尚未实现；最后更新：2026-08-08。
>
> 本文取代早期以固定人形姿态表和特定生成 provider 为中心的试验方案。它定义 FrameBaker 面向成熟工具的长期动画内核、交换格式、扩展边界、迁移路线和验收标准。已实现 API 仍以 [`api.md`](./api.md) 为准，当前运行架构以 [`architecture.md`](./architecture.md) 为准。

## 1. 产品目标

FrameBaker 的目标不是某个 AI 模型、Spine 或逐帧图片生成器的前端，而是一个可长期维护的动画生产工具：

- 用统一资产表达骨架、动作、角色绑定、约束和光栅结果；
- 同时支持手工编辑、文件导入、程序化生成、AI 生成和动作捕捉；
- 生成结果必须可编辑、可复现、可迁移，不能只得到一次性视频；
- 骨骼编辑与逐帧像素润色并存，骨骼可以确定性烘焙为现有项目帧；
- 外部格式、模型和运行时都通过 adapter 接入，可替换且不会污染项目数据；
- 项目在 provider、模型或外部服务下线后仍可打开、编辑和导出；
- 格式、任务、迁移、许可证和质量检查按可商业发布的软件要求设计。

AI 在系统中的定位是**可选生产力来源**，不是动画数据的事实源。经用户确认和转换后的 FrameBaker 资产才是事实源。

## 2. 已冻结的架构决策

以下决策是后续实现的约束；变更时必须修改本文并记录迁移影响。

1. **通用内核优先**：不以 `humanoid-v1`、Spine、BVH、glTF 或任何模型输出作为内部唯一格式。
2. **资产职责分离**：`Skeleton`、`MotionClip`、`CharacterBinding`、`ConstraintSet`、`RenderProfile`、`RasterSequence` 独立保存和引用。
3. **动作与外观分离**：`MotionClip` 不包含角色图片、Slot 或 provider 请求；同一动作可重定向到多个角色。
4. **源资产与派生产物分离**：姿态表、预览视频、PNG 序列和精灵图都是可再生成产物，不能替代骨架与动作源数据。
5. **时间使用秒**：关键帧时间以秒表示；FPS 是预览或烘焙策略，不是动作数据的时间单位。
6. **局部变换为主**：骨骼轨道保存相对父骨骼的局部 TRS；世界坐标由 FK 求值，不逐帧持久化为事实源。
7. **统一三维变换**：2D 与 3D 骨架共用 `translation[3] + quaternion[4] + scale[3]`，2D 资产通常令 `z=0`。UI 可显示角度，但持久化不用欧拉角作为标准旋转。
8. **稳定 ID 优先**：层级、轨道和绑定引用稳定 ID，不通过骨骼显示名称建立关系。人体语义标签是可选映射，不限制拓扑。
9. **约束可烘焙**：IK、接触和角度约束独立于基础轨道；目标格式不支持时可以烘焙成关键帧，但必须报告有损转换。
10. **开放包格式**：建立版本化、可校验、可迁移的 FrameBaker Animation Package；首版采用 ZIP + JSON + PNG，规范公开。
11. **格式 adapter 隔离**：BVH、glTF、Spine、DragonBones 和模型专用格式只存在于导入、导出或 provider adapter。
12. **能力而非厂商建模**：Provider 按 `text-to-motion`、`video-to-motion`、`auto-rigging` 等能力声明，不在核心类型中加入厂商分支。
13. **持久任务**：动作生成、动作捕捉、重定向和批量烘焙进入可恢复任务系统，不能长期依赖前端等待或仅内存 payload。
14. **转换不静默丢失**：导入导出必须产生兼容性报告；无法表达的特性需明确降级、烘焙或拒绝。
15. **光栅编辑语义不变**：现有 `Frame.offset_x/y`、`rotation`、`scale`、`opacity` 只表示整张帧图片变换，骨骼数据不得写入这些字段或长期塞入 metadata。

## 3. 当前实现与替换策略

`/motions` 当前实现是一个有效的交互原型，但不是最终数据模型：

- 固定 `humanoid-v1` 人形拓扑；
- 根节点二维平移和逐骨骼弧度旋转；
- PixiJS FK、关节拖拽、镜像、视角和动作参数；
- Quaternius CC0 动作采样成 8–16 帧预设；
- 动作关键帧编辑、循环播放和 512×512 姿态表导出；
- 姿态表上传素材库后可作为现有图片生成链路的第二张参考图。

当前 `MotionKeyframe` 和 `HumanoidBoneId` 只服务该页面的内存状态，未持久化为用户资产，不做格式兼容、迁移器或历史记录。现有骨骼编辑、内置动作和姿态表功能继续保留；正式动画资产 UI 完成后直接改用通用 `Skeleton + MotionClip`，届时删除不再使用的固定人形类型和计算代码。已有姿态表工作流可继续作为一种 `RenderProfile` 输出。

现有双参考图属于普通多图语义引导，不等同于强姿态控制。它是通用动作资产的一个下游消费者，不再决定骨架系统是否成立。

## 4. 领域模型

以下类型描述语义边界，不要求实现时逐字照抄字段名；冻结的是职责、坐标和引用关系。

### 4.1 公共约定

```ts
interface AssetIdentity {
  schemaVersion: number;
  kind: "skeleton" | "motion-clip";
  id: string;
  name: string;
  extensions?: Record<string, unknown>;
}

interface Transform {
  translation: [number, number, number];
  rotation: [number, number, number, number]; // quaternion: x, y, z, w
  scale: [number, number, number];
}

interface CoordinateSystem {
  handedness: "right" | "left";
  upAxis: "x" | "y" | "z";
  forwardAxis: "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
  unit: "meter" | "pixel" | "normalized";
}
```

规范默认采用右手系、Y 向上、Z 向前、四元数顺序 `x,y,z,w`。外部 adapter 必须显式转换；2D 画布 Y 向下只属于渲染映射，不改变资产坐标。局部矩阵采用列向量 `T * R * S`；轨道值替换对应 Rest Transform 通道，不是增量值。层级非均匀缩放可能产生剪切，因此 FK 的权威世界结果必须是完整 4×4 仿射矩阵，不能用拆分后的 world TRS 代替。

### 4.2 Skeleton

`Skeleton` 只描述层级和 Rest Pose，不包含动作与图片：

```ts
interface Skeleton extends AssetIdentity {
  coordinateSystem: CoordinateSystem;
  bones: Bone[];
  semanticProfile?: SkeletonSemanticProfile;
}

interface Bone {
  id: string;
  name: string;
  parentId: string | null;
  rest: Transform;
  tipOffset?: [number, number, number];
  semantic?: string;
}
```

要求：

- 支持任意拓扑，包括人体、四足、尾巴、翅膀、多足、机械和道具；
- 至少一个根骨骼，禁止父子环；
- 骨架是 joint-origin 层级，子骨骼原点只由子骨骼的 `rest.translation` 确定，不从父骨长推导；
- `tipOffset` 只是骨骼本地坐标中的可选显示骨端，不参与拓扑，可表达 BVH End Site 的任意方向；
- 语义标签如 `hips`、`leftFoot` 用于重定向，不作为骨骼 ID；
- Rest Pose 是绑定和重定向依据，导入时必须保留或明确推导来源。

### 4.3 MotionClip

`MotionClip` 是与外观无关的连续时间动作：

```ts
interface MotionClip extends AssetIdentity {
  skeletonId: string;
  duration: number;
  loop: boolean;
  tracks: MotionTrack[];
  events: MotionEvent[];
  contacts?: ContactTrack[];
  rootMotion?: RootMotionPolicy;
  provenance?: AssetProvenance;
}

interface MotionTrack {
  targetId: string;
  property: "translation" | "rotation" | "scale";
  interpolation: "step" | "linear"; // cubic 留待后续 schema 版本定义
  keyframes: Array<{ time: number; value: number[] }>;
}
```

要求：

- `time` 范围为 `0..duration` 秒且有序；
- 旋转插值使用最短路径 slerp，导入欧拉角时先完成解卷绕；
- 根运动可保留、提取为独立轨道或转换为原地动作；
- 事件、脚底接触、命中点不能依赖光栅帧序号；
- FPS 只在预览、采样和烘焙配置中出现；
- 非循环采样钳制到闭区间 `[0, duration]`；循环采样使用半开区间 `[0, duration)`，`duration` 映射回 `0`；
- 循环轨道允许在 `duration` 放置首帧副本以定义接缝插值，但循环事件必须位于 `[0, duration)`，接触区间可以结束于 `duration`。

### 4.4 CharacterBinding

`CharacterBinding` 连接骨架与可渲染外观：

```ts
interface CharacterBinding extends AssetIdentity {
  skeletonId: string;
  slots: Slot[];
  attachments: Attachment[];
  skins?: Skin[];
}
```

首个生产版本只要求 Region Attachment：PNG、Pivot、所属 Slot、Rest Transform 和默认绘制顺序。Mesh、权重、变形和物理是兼容扩展，不阻塞基本 cutout 工作流。

Slot/Attachment 与骨骼分离，以支持换皮、武器、正背面附件切换和 Draw Order。单张未切片角色图也可作为特殊绑定输入，但不能假装已经具备蒙皮能力。

### 4.5 ConstraintSet

约束作为独立可复用资产或绑定内引用，至少预留：

- two-bone IK；
- transform/aim constraint；
- 关节角度限制；
- 脚底和手部接触；
- look-at；
- path；
- attachment 跟随与切换规则。

约束求值顺序必须版本化。导出到不支持约束的格式时，按指定采样率烘焙并记录误差。

### 4.6 RenderProfile 与 RasterSequence

```ts
interface RenderProfile extends AssetIdentity {
  camera: CameraSettings;
  outputFps: number;
  canvasSize: [number, number];
  origin: [number, number];
  sampling: "nearest" | "linear";
  pixelSnap: boolean;
  frameSelection: "uniform" | "key-pose" | "contact-aware";
  paletteId?: string;
}
```

`RasterSequence` 记录烘焙来源、帧文件、每帧时长、公共原点、画布和校验值，并可导入现有项目帧。骨骼资产和烘焙帧之间保留来源关系；重新烘焙默认创建新版本，不静默覆盖人工修过的帧。

## 5. FrameBaker Animation Package

建议扩展名为 `.fbanim`，逻辑布局如下：

```text
character.fbanim
├── manifest.json
├── skeletons/
│   └── <sha256>.json
├── motions/
│   └── <sha256>.json
│
│   # 以下目录由后续独立资产 schema 启用，v1 暂不接受
├── bindings/
│   └── default.json
├── constraints/
│   └── feet.json
├── render-profiles/
│   └── pixel-side-view.json
├── textures/
│   ├── body.png
│   └── sword.png
├── previews/
└── provenance.json
```

### 5.1 包规范要求

- `manifest.json` 包含包版本、资产索引、依赖关系、内容哈希和创建工具版本；
- v1 资产文件名是规范 JSON 内容的 SHA-256，摘要与字节数都针对未压缩的 RFC 8785 UTF-8 字节；
- 当前实现以 `{ path, bytes }` 逻辑条目建立、验证和往返，ZIP 仅是后续传输层；在具备重复路径、压缩炸弹、CRC、大小与压缩比防护的读取器前，不复用现有仅导出用途的 ZIP 写入器；
- 路径必须相对包根且禁止 `..`，解包时防止路径穿越和压缩炸弹；
- JSON 使用正式 schema 校验，未知可选扩展在往返保存时尽量保留；
- 纹理使用 PNG；预览文件不是必需且不参与事实源计算；
- 包内 ID 保持稳定，导入数据库发生冲突时生成映射而不是改写内部引用失败；
- 首版优先可读性和迁移能力，性能确有需要时再为密集关键帧增加可选二进制块；
- 数据库 schemaVersion、`.fbanim` packageVersion 和各资产 schemaVersion 分开演进。

### 5.2 扩展机制

通用扩展使用反向域名命名空间，例如 `extensions["org.example.feature"]`，值必须可序列化为 JSON。核心不能依赖未知扩展才能完成基本 FK 和播放；进入核心的能力需要升级正式 schema。Skeleton 与 MotionClip 使用独立的版本常量和 `kind` 判别字段，迁移器按资产种类分派；未知扩展往返保存时原样保留。

## 6. 外部格式策略

不存在一种行业格式能同时完整表达 3D 动作、2D Slot/Draw Order、像素渲染和 FrameBaker 编辑状态，因此采用多 adapter，而不是强行选一个外部格式做数据库模型。

| 格式 | 主要用途 | 基线策略 |
| --- | --- | --- |
| glTF 2.0 | 通用 3D 骨架、Skin、动画交换 | 优先标准；支持导入导出并报告扩展缺失 |
| BVH | 动捕和人体动作交换 | 优先导入；保留层级、帧率和根运动 |
| FBX | DCC 生态交换 | 经 Blender/独立转换器接入，不自行实现完整解析器 |
| Spine JSON | 2D 商业生态 | 可选 adapter；运行时和许可证独立评估 |
| DragonBones JSON | 2D cutout 交换 | 可选 adapter |
| PNG 序列 + JSON | 稳定光栅交付 | 完整支持，保持公共原点与每帧时长 |
| GIF/APNG/WebM | 预览与分享 | 不作为可编辑源资产 |

Adapter 输出 `CompatibilityReport`，至少包含 `info/warning/error`、受影响资产、发生的烘焙或丢失。禁止静默丢弃 Mesh、约束、事件、Draw Order、曲线或根运动。

## 7. Provider 与任务边界

Provider 按能力声明，而不是按厂商名称扩展核心联合类型：

```ts
type AnimationCapability =
  | "text-to-motion"
  | "video-to-motion"
  | "pose-to-motion"
  | "motion-inpainting"
  | "motion-retargeting"
  | "auto-rigging"
  | "character-reskinning"
  | "motion-rendering";
```

标准输出是 `AnimationArtifact`，可包含 Skeleton、MotionClip、Binding、RasterSequence、预览、来源和兼容警告。厂商参数保存在 provenance/request snapshot，不进入 MotionClip。

每次生成必须记录：

- provider adapter 与版本；
- 模型、checkpoint 或服务版本；
- prompt、seed、时长和完整有效参数；
- 输入资产 ID 与内容哈希；
- 原始产物；
- 坐标转换和骨架映射版本；
- 后处理、IK、平滑、循环修复和采样参数；
- 许可证来源与用户确认状态。

动作任务需要独立 job 类型，payload 持久化并支持重启恢复、取消、超时、阶段进度、临时目录隔离、原子提交和失败清理。调度依赖继续保持 `queue.ts → jobs/*` 单向。

## 8. 编辑与渲染工作流

成熟工作流按非破坏方式组织：

```text
导入/生成 MotionClip
  → 坐标标准化与骨架映射
  → 重定向到目标 Skeleton
  → FK/IK、接触、曲线和循环编辑
  → CharacterBinding 预览
  → RenderProfile 确定性烘焙
  → RasterSequence 版本
  → 导入现有帧编辑器做像素级润色
```

骨骼轨道负责大范围动作修改，光栅轨道负责最终像素质量。人工修帧后再次烘焙必须由用户选择新建版本、覆盖未修改帧或显式覆盖全部，不能自动破坏人工成果。

## 9. 像素动画要求

骨骼动作流畅不代表像素动画可用。烘焙器必须支持：

- 最近邻采样和关闭抗锯齿；
- 根节点、Pivot 和主要关节的整数像素吸附；
- 可选旋转量化；
- 固定调色板与透明度规则；
- 6/8/10/12 FPS 等低帧率采样；
- contact-aware/key-pose 采样，保护落脚、蓄力、命中和极值姿势；
- 公共原点、地面线和统一单元格；
- 近重复帧删除；
- 首尾循环误差、一像素抖动、透明接缝和裁边检查；
- 对 Draw Order 频繁切换增加迟滞，避免前后肢体闪烁。

## 10. 持久化与模块边界

目标资产使用独立表或等价的正式存储：

- `skeletons`；
- `motion_clips`；
- `character_bindings`；
- `constraint_sets`；
- `render_profiles`；
- `raster_sequences`；
- `asset_dependencies`；
- `animation_jobs` 或扩展后的统一 jobs payload。

大量关键帧是否拆表由性能测量决定；首版可存版本化 JSON，但必须支持事务、引用检查和迁移。骨架、动作和绑定应成为独立文件夹资产类型，不伪装成 material。

删除资产必须处理引用关系：阻止删除、级联删除派生产物或显式解除引用。导入包和任务提交均需原子化，不能留下半个可见资产。

## 11. 质量与兼容性门禁

### 11.1 数据门禁

- schema 校验通过；
- ID 唯一且引用有效；
- 骨架无环，Transform 数值有限；
- 关键帧时间合法且有序；
- quaternion 非零并归一化；
- 包路径与大小安全；
- 迁移前后 FK 采样误差在阈值内。

### 11.2 动作门禁

- 骨长不随帧异常变化；
- 根节点无非预期突跳；
- 关节速度和角度不越限；
- 脚底接触段滑动在阈值内；
- 循环首尾姿态、速度和根位移满足策略；
- 重定向后缺失/额外骨骼有明确报告；
- 事件、命中点和接触点在重采样后保持时间语义。

### 11.3 光栅门禁

- 无空帧、非法尺寸和画布裁切；
- 公共原点稳定；
- 调色板和透明边符合 profile；
- 无非预期一像素抖动和 Slot 顺序闪烁；
- 帧数、时长与采样配置一致；
- 同一输入、版本和参数重复烘焙得到相同结果。

## 12. 实施路线

### Phase A — 固化通用内核

- [x] 定义坐标、时间、TRS、ID 和扩展规范；
- [x] 建立正式共享类型与 Skeleton / MotionClip 运行时校验；
- [x] 补充独立 JSON schema 文件及其版本发布流程；
- [x] 实现 FK 求值、连续时间采样和基础 schema 校验；
- [x] 实现 `.fbanim` v1 manifest、逻辑条目构建与完整性验证；未知版本直接拒绝，不建立无用户数据的旧格式迁移层；
- [x] 保留现有骨骼动画功能，不增加无使用方的兼容层或旧格式记录；
- [x] 建立矩阵 FK、时间边界和非法输入检查；
- [x] 为 `.fbanim` 建立规范编码、摘要、路径安全、往返、确定性与 FK 等价检查；

验收：不依赖任何 AI provider，通用 Skeleton/MotionClip 可以保存、重开、播放、导出再导入且采样结果一致。

### Phase B — 正式资产与编辑闭环

- [ ] 独立持久化、文件夹、引用关系和 CRUD API；
- [ ] 动作时间轴改为连续时间轨道；
- [ ] Undo/Redo、曲线、事件、根运动和循环工具；
- [ ] CharacterBinding 的 Region Attachment、Pivot、Slot 和 Draw Order；
- [ ] RenderProfile 与确定性 PNG 序列烘焙；
- [ ] 烘焙版本与人工修帧保护策略。

验收：同一动作可驱动至少两个不同角色绑定，并可重复烘焙后进入现有帧编辑器。

### Phase C — 通用交换与重定向

- [ ] BVH 导入与标准化；
- [ ] glTF 2.0 导入导出；
- [ ] 语义骨骼映射和人工映射 UI；
- [ ] Rest Pose 对齐、比例缩放、根运动和局部轴转换；
- [ ] compatibility report；
- [ ] 基础 IK、脚底接触、关键帧简化和循环修复。

验收：至少两个外部来源动作可无厂商特例地映射到同一 FrameBaker 骨架，所有降级均可见。

### Phase D — 通用生成 Provider

- [ ] 定义 capability、request、artifact 和 provenance 协议；
- [ ] 持久化动作任务与恢复机制；
- [ ] 接入至少一个本地或远程动作来源作为 adapter；
- [ ] 候选比较、原始产物保留和质量报告；
- [ ] 视频动作捕捉、文本动作等能力可独立扩展；
- [ ] 模型安装、doctor、资源预算和许可证确认流程。

验收：移除或替换 provider 后，已创建资产仍可完整编辑和烘焙。

### Phase E — 生态与高级形变

- [ ] Spine/DragonBones 等可选 adapter；
- [ ] Mesh、蒙皮权重和 deform；
- [ ] 高级约束、附件切换和次级运动；
- [ ] 四足与自定义语义 profile；
- [ ] 批量生产、质量回归和插件 SDK。

该阶段由实际生产需求驱动，不允许反向破坏通用内核。

## 13. 非目标与避免事项

- 不把某个研究仓库直接嵌入核心数据层；
- 不把 Spine 当作 FrameBaker 项目格式；
- 不因首个模型只支持人体而冻结人形专用 schema；
- 不用每帧绝对关节坐标替代可编辑的局部轨道；
- 不把预览 MP4、姿态表或生成 PNG 当作动作源文件；
- 不为通过单个模型测试而硬编码骨骼名、帧数或输出目录；
- 不在没有兼容性报告时做有损导入导出；
- 不在许可不清晰时捆绑模型、checkpoint、运行时或训练数据；
- 不承诺骨骼可以单独解决脸、服装、武器、披风和像素风格一致性。

## 14. 尚未冻结的实现细节

以下内容应通过原型和测量后决定，不妨碍上述架构实施：

- JSON schema 库与运行时校验实现；
- 关键帧 JSON 与二进制块的性能分界；
- 数据库是按资产整块存 JSON 还是拆分高频轨道；
- cubic curve 的具体控制点编码；
- Mesh/权重的首个正式 schema；
- glTF 扩展与 2D Draw Order 的映射策略；
- 多角色、场景级动作编排是否进入同一包格式；
- provider 运行在一次性 CLI、常驻 sidecar 还是远程服务。

这些选择必须服从已冻结边界：可迁移、可替换、可复现、无静默数据损失。
