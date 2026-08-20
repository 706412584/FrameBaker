# 通用动画资产与骨骼工作流规范

> 状态：架构基线、核心资产、独立 schema、`.fbanim` v2 运行时包、正式资产持久化 API 与基础资产 UI 已实现；最后更新：2026-08-12。
>
> 本文取代早期以固定人形姿态表和特定生成 provider 为中心的试验方案。它定义 FrameBaker 面向成熟工具的长期动画内核、交换格式、扩展边界、迁移路线和验收标准。已实现 API 仍以 [`api.md`](./api.md) 为准，当前运行架构以 [`architecture.md`](./architecture.md) 为准。

## 1. 产品目标

FrameBaker 的目标不是某个 AI 模型、Spine 或逐帧图片生成器的前端，而是一个可长期维护的动画生产工具：

- 用统一资产表达骨架、动作、角色绑定和约束；
- 同时支持手工编辑、文件导入、程序化生成、AI 生成和动作捕捉；
- 生成结果必须可编辑、可复现、可迁移，不能只得到一次性视频；
- 骨骼编辑与逐帧像素润色作为两种独立项目类型并存，二者不互相转换；
- 外部格式、模型和运行时都通过 adapter 接入，可替换且不会污染项目数据；
- 项目在 provider、模型或外部服务下线后仍可打开、编辑和导出；
- 格式、任务、迁移、许可证和质量检查按可商业发布的软件要求设计。

AI 在系统中的定位是**可选生产力来源**，不是动画数据的事实源。经用户确认和转换后的 FrameBaker 资产才是事实源。

## 2. 已冻结的架构决策

以下决策是后续实现的约束；变更时必须修改本文并记录迁移影响。

1. **通用内核优先**：不以 `humanoid-v1`、Spine、BVH、glTF 或任何模型输出作为内部唯一格式。
2. **动作与项目职责分离**：动作库只保存并引用 `Skeleton`、`MotionClip`；`CharacterBinding` 由具体骨骼项目持有；`ConstraintSet` 后续按实际复用边界归属。
3. **动作与外观分离**：`MotionClip` 不包含角色图片、Slot 或 provider 请求；同一动作可重定向到多个角色。
4. **源资产与预览分离**：姿态表和预览视频都是可再生成产物，不能替代骨架与动作源数据。
5. **时间使用秒**：关键帧时间以秒表示；FPS 只用于预览采样，不是动作数据的时间单位。
6. **局部变换为主**：骨骼轨道保存相对父骨骼的局部 TRS；世界坐标由 FK 求值，不逐帧持久化为事实源。
7. **统一三维变换**：2D 与 3D 骨架共用 `translation[3] + quaternion[4] + scale[3]`，2D 资产通常令 `z=0`。UI 可显示角度，但持久化不用欧拉角作为标准旋转。
8. **稳定 ID 优先**：层级、轨道和绑定引用稳定 ID，不通过骨骼显示名称建立关系。人体语义标签是可选映射，不限制拓扑。
9. **约束可烘焙**：IK、接触和角度约束独立于基础轨道；目标格式不支持时可以烘焙成关键帧，但必须报告有损转换。
10. **开放包格式**：建立版本化、可校验、可迁移的 FrameBaker Animation Package；首版采用 ZIP + JSON + PNG，规范公开。
11. **格式 adapter 隔离**：BVH、glTF、Spine、DragonBones 和模型专用格式只存在于导入、导出或 provider adapter。
12. **能力而非厂商建模**：Provider 按 `text-to-motion`、`video-to-motion`、`auto-rigging` 等能力声明，不在核心类型中加入厂商分支。
13. **持久任务**：动作生成、动作捕捉和重定向进入可恢复任务系统，不能长期依赖前端等待或仅内存 payload。
14. **转换不静默丢失**：导入导出必须产生兼容性报告；无法表达的特性需明确降级、烘焙或拒绝。
15. **光栅编辑语义不变**：现有 `Frame.offset_x/y`、`rotation`、`scale`、`opacity` 只表示整张帧图片变换，骨骼数据不得写入这些字段或长期塞入 metadata。
16. **双项目类型**：统一项目入口下存在不可变的 `frame` 与 `skeletal` 两种项目类型；存量和省略类型的新项目均为 `frame`，项目类型创建后不可原地转换。
17. **动作与项目分工**：`/motions` 只生产可复用 Skeleton 与 MotionClip，不读取或绑定素材；骨骼项目独占 CharacterBinding，用素材组装具体角色、引用同骨架动作、编排最终序列并导出运行时包。
18. **骨骼输出唯一**：骨骼项目只输出包含骨架、最终动作、角色绑定和纹理闭包的 `.fbanim` 运行时包，不再提供转换为逐帧项目的兼容线路。
19. **生成意图隔离**：底层 provider、抠图和图像处理能力共享；上层任务必须区分逐帧图片/序列/视频、骨骼部件生成、参考角色拆分和 MotionClip 生成，不能仅用 `image | video` 表达产物语义。

## 2.1 双项目工作流

项目列表是逐帧动画与骨骼动画的统一入口。项目类型决定编辑器、数据和主导出格式，而不是页面路由：

| 项目类型 | 事实源 | 编辑器职责 | 主导出 |
| --- | --- | --- | --- |
| `frame` | 有序 `Frame[]` 与独立 PNG | 洋葱皮、逐帧变换、排序、逐帧时长和人工修帧 | PNG 序列 / Spritesheet |
| `skeletal` | 项目角色 + 命名骨骼序列 | 素材组装、Slot/Attachment、动作引用/复制、trim/变速/重复、事件和 Root Motion | `.fbanim` 运行时包 |

两种项目类型互不转换。`/motions` 是共享动作资产工作台，不拥有最终角色项目编排。它负责 Rig/Skeleton、单个 MotionClip、事件和循环接缝，不读取素材，也不创建 Slot、Attachment 或 CharacterBinding。具体 `materialId`、图片镜像、Pivot、Draw Order 和项目角色外观全部由骨骼项目持有；项目只能直接引用 `skeletonId` 完全相同的动作，重定向不属于基础项目流程。

## 2.2 双生成线路

生成 UI 先由项目类型隔离，再按用户意图使用 Tab；Provider 厂商不是顶层信息架构：

- 逐帧项目：`上传素材`、`AI 单图`、`AI 动作序列`、`GIF/视频`、`素材库`；产物最终都是 Frame。
- 骨骼项目角色：`已有部件组装`、`参考精灵拆分`、`AI 生成部件`、`导入骨骼包`。
- 骨骼项目动作：`动作库`、`AI 生成动作`、`导入动作`、`项目动作`。
- 骨骼项目导出：仅 `.fbanim` 骨骼运行时包。

参考精灵拆分包含两条明确路径：已有部件表使用确定性的网格/区域切分；完整组装角色先以引用图生成标准部件表草稿，再切分、逐件抠图、透明边扫描和紧边裁剪。AI 拆分必须经过草稿确认，不能假设可无损恢复被遮挡部位。

## 3. 当前实现与替换策略

`/motions` 已统一使用正式的 `Skeleton + MotionClip` 数据模型和连续时间编辑器。早期固定人形、仅内存关键帧、姿态表素材导出和角色参考图流程已经从该入口移除，避免动作制作反向依赖素材与图片生成链路。内置动作仍作为只读 `MotionClip` 存在，需要编辑时先复制到动作库。

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

interface MotionTrackV1 {
  targetId: string;
  property: "translation" | "rotation" | "scale";
  interpolation: "step" | "linear";
  keyframes: Array<{ time: number; value: number[] }>;
}

interface MotionTrackV2 {
  targetId: string;
  property: "translation" | "rotation" | "scale";
  keyframes: Array<{
    time: number;
    value: number[];
    // 当前 key 到下一 key 的时间插值；最后一个 key 固定为 null
    outInterpolation: { type: "step" | "linear" }
      | { type: "cubic-bezier"; x1: number; y1: number; x2: number; y2: number }
      | null;
  }>;
}
```

要求：

- `time` 范围为 `0..duration` 秒且有序；
- v1 保持轨道级 `step | linear` 原语义；v2 的插值由片段起始 key 持有，cubic-bezier 四个控制量均为 `[0, 1]`；
- v1 → v2 只通过显式操作迁移：step/linear 无损映射到每个片段，读取旧资产不会自动写回升级；
- cubic-bezier 只改变归一化时间量；位移/缩放仍用 lerp，旋转仍用最短路径 slerp，不对四元数分量做 Hermite；
- 旋转插值使用最短路径 slerp，导入欧拉角时先完成解卷绕；
- 根运动可保留、提取为独立轨道或转换为原地动作；
- 事件、脚底接触、命中点不能依赖光栅帧序号；
- FPS 只在预览和 adapter 采样配置中出现；
- 非循环采样钳制到闭区间 `[0, duration]`；循环采样使用半开区间 `[0, duration)`，`duration` 映射回 `0`；
- 循环轨道允许在 `duration` 放置首帧副本以定义接缝插值，但循环事件必须位于 `[0, duration)`，接触区间可以结束于 `duration`。

### 4.4 CharacterBinding

`CharacterBinding` 连接骨架与可渲染外观，并且只作为骨骼项目文档的一部分保存：

```ts
interface CharacterBinding extends AssetIdentity {
  skeletonId: string;
  slots: Slot[];
  attachments: Attachment[];
}
```

v1 只包含 Region Attachment：显式 PNG 素材槽位、Size、Pivot、Rest Transform、Bone Slot 和唯一 Draw Order；不包含 skins、Mesh、权重、变形或物理。

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

## 5. FrameBaker Animation Package

建议扩展名为 `.fbanim`，逻辑布局如下：

```text
character.fbanim
├── manifest.json
├── skeletons/
│   └── <sha256>.json
├── motions/
│   └── <sha256>.json
├── bindings/
│   └── <sha256>.json
├── constraints/
│   └── feet.json
├── textures/
│   └── <sha256>.png
├── previews/
└── provenance.json
```

### 5.1 包规范要求

- `manifest.json` 包含包版本、资产索引、依赖关系、内容哈希和创建工具版本；
- v1 资产文件名是规范 JSON 内容的 SHA-256，摘要与字节数都针对未压缩的 RFC 8785 UTF-8 字节；
- v2 是与 v1 平行的运行时包 API（`buildFbanimV2Entries` / `verifyFbanimV2Entries`），`format: "fbanim"`、`version: 2`。每个包只闭包一个项目本地 `CharacterBinding` 及其 `Skeleton`，并按项目动作 ID 排序收录动作名、MotionClip 路径、speed、repeat 和 loop；不会改变 v1 的多资产交换行为；
- v2 的 JSON 和 PNG 均以内容摘要命名。manifest 的 `entry` 显式记录 skeleton、characterBinding、actions、textures 的路径、SHA-256、字节数和骨架依赖；每个 attachmentId 必须恰好映射一个 `textures/*.png`。绑定中的 materialId 仅作来源记录，运行时纹理由该映射解析；
- v2 构建与验证拒绝未知核心字段、重复 ID/路径、非规范 JSON、路径穿越、摘要或字节数不符、非 PNG 签名、缺失/多余文件、附件引用和 Skeleton 不匹配，并在读取内容前执行文件数、单文件及总解压字节预算；
- 当前实现以 `{ path, bytes }` 逻辑条目建立、验证和往返，`.fbanim` 是 ZIP 传输层；FrameBaker 已支持在骨骼项目中导入该包，导入时会校验摘要和安全预算，并为本地数据库 ID 建立映射；
- 路径必须相对包根且禁止 `..`，解包时防止路径穿越和压缩炸弹；
- JSON 使用正式 schema 校验，未知可选扩展在往返保存时尽量保留；
- 纹理使用 PNG；预览文件不是必需且不参与事实源计算；
- 包内 ID 保持稳定，导入数据库发生冲突时生成映射而不是改写内部引用失败；
- 首版优先可读性和迁移能力，性能确有需要时再为密集关键帧增加可选二进制块；
- 数据库 schemaVersion、`.fbanim` packageVersion 和各资产 schemaVersion 分开演进。

### 5.2.1 使用方式

- FrameBaker：打开任意骨骼项目，点击“导入骨骼 ZIP”，会恢复骨架、角色绑定、纹理和动作；已有角色与动作会先要求确认替换。导出文件直接使用 `.zip` 扩展名，系统和其他工具无需认识自定义扩展名即可打开；旧的 `.fbanim` 文件仍可导入。
- 其他运行时：按 ZIP 读取 `manifest.json`，根据 `entry` 中的 `path` 读取 JSON/PNG，校验 `sha256` 与 `byteLength`，再按 `characterBinding.attachments[].id → textures[].attachmentId` 建立纹理映射；动作播放读取对应 MotionClip 的 tracks，并应用 action 的 `speed`、`repeat`、`loop`。
- 该格式是公开的 JSON + PNG 规范，不要求安装 FrameBaker；`packages/shared/src/animationPackageV2.ts` 中的校验规则和本文档就是实现依据。

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

标准输出是 `AnimationArtifact`，可包含 Skeleton、MotionClip、Binding、预览、来源和兼容警告。厂商参数保存在 provenance/request snapshot，不进入 MotionClip。

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

## 8. 编辑与运行时工作流

成熟工作流按非破坏方式组织：

```text
导入/生成 MotionClip
  → 坐标标准化与骨架映射
  → 重定向到目标 Skeleton
  → FK/IK、接触、曲线和循环编辑
  → 在骨骼项目中建立 CharacterBinding 并预览
  → 打包项目动作、角色绑定与纹理闭包
  → 导出并验证 .fbanim 运行时包
```

## 9. 运行时包要求

骨骼项目导出的 `.fbanim` 必须自包含最终动作、角色绑定及其纹理闭包，并保留动作速度、重复次数、事件和 Root Motion 语义。导出前校验所有引用与纹理摘要；消费端负责采样、像素吸附、过滤和 Draw Order 等渲染策略，编辑器不额外生成光栅兼容产物。

## 10. 持久化与模块边界

目标资产使用独立表或等价的正式存储：

- `skeletons`；
- `motion_clips`；
- `character_bindings`；
- `constraint_sets`；
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

### 11.3 运行时包门禁

- manifest、资产和纹理摘要全部匹配；
- 骨架、绑定、动作和附件引用闭合；
- 动作速度、重复次数、循环、事件与 Root Motion 语义完整；
- 包路径、文件数和体积符合安全限制；
- 相同输入和工具版本得到字节一致的逻辑条目。

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

- [x] 独立持久化、文件夹、引用关系和 CRUD API；
- [x] 正式资产 UI 的基础浏览、文件夹管理、JSON 导入、改名/删除与连续时间只读预览；
- [x] 动作时间轴改为连续时间轨道；当前完成通用骨骼选择、基础 2D TRS 关键帧写入/删除、即时持久化与覆盖全部 clip 编辑的会话内 Undo/Redo；
- [x] schema v1 可表达的轨道插值（step/linear）、事件 type/name/payload 新增与查看/删除、根运动策略选择与基础循环接缝修复；
- [x] MotionClip v2 逐片段 cubic-bezier 时间曲线、显式 v1 无损迁移、确定性采样与 `.fbanim` 往返兼容；
- [ ] 其余高级循环工具（根运动提取算法/可视化及接触感知接缝）；
- [x] 项目内 CharacterBinding v1 的 Region Attachment、Pivot、Slot 和 Draw Order（仅 Region，不含 skins/mesh）；动作资产库不保存绑定；

验收：同一动作可驱动至少两个不同角色绑定，并能随项目角色一起确定性导出 `.fbanim` 运行时包。

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

验收：移除或替换 provider 后，已创建资产仍可完整编辑和导出。

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
- Mesh/权重的首个正式 schema；
- glTF 扩展与 2D Draw Order 的映射策略；
- 多角色、场景级动作编排是否进入同一包格式；
- provider 运行在一次性 CLI、常驻 sidecar 还是远程服务。

这些选择必须服从已冻结边界：可迁移、可替换、可复现、无静默数据损失。

## 15. 部件偏移轨道（att: 目标）

MotionClip 除骨骼轨道外，允许 `targetId` 以 `att:` 为前缀（`att:<attachmentId>`）的**部件偏移轨道**，用于在不改动 CharacterBinding 静止位形的前提下，让某个动作单独调整部件位置/角度（例如修正垂腕、持物手）。

约定：

- `property` 支持 `translation`（Vec3，z 固定 0，单位为 rest 后局部像素）、`rotation`（归一化四元数，仅 Z 轴旋转）、`scale`（Vec3，z 固定 1）与 `deform`（Vec3，x 为 bend 弯曲增量，y/z 保留为 0 备用）；`deform` 仅对 `att:` 目标合法，骨骼目标会被校验拒绝；
- 轨道值是**叠加偏移**而非替换：最终部件矩阵为 `boneWorld × transformToMatrix(attachment.rest) × offsetMatrix(t)`（offsetMatrix 为 T×R×S 组合），无轨道时偏移为单位变换，渲染与既有行为完全一致；deform 的有效 bend = 绑定静态 bend + 轨道增量，axis/sway/frequency/phase 仍取绑定静态参数（无 deform 绑定的部件按纵向轴默认参数渲染）；
- 校验上 `att:` 目标跳过「目标骨骼必须存在」检查（attachment 属于项目侧绑定，动作库不持有），其余关键帧/插值校验与骨骼轨道一致；
- `sampleMotionClip` 返回的 `EvaluatedPose.attachmentOffsets` 以去掉前缀的 attachmentId 为 key 给出当前时刻的偏移采样值（translation/rotation/scale/deformBend）；
- 动作编辑器在角色预览模式下点击部件即可选中，拖动平移、拖动圆柄旋转、拖动角柄缩放、检查器滑杆调弯曲，写入/删除关键帧作用于 `att:<id>` 的 translation/rotation/scale/deform 轨道；时间线轨道行显示部件名。
