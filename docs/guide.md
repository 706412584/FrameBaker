# FrameBaker 使用指南

像素风逐帧动画编辑器：素材导入（GIF/MP4 拆帧、PNG 上传、AI 生成）→ 剪裁/抠图加工 → 帧编辑（洋葱皮）→ 时间轴排序 → 播放预览 → 导出精灵表。

本文面向使用者，按页面讲清每个功能怎么用。接口细节见 [api.md](api.md)，内部实现见 [architecture.md](architecture.md)。

## 快速开始

```bash
bun install
bun dev          # → http://localhost:3000（PORT 可覆盖）
./scripts/setup_matting.sh   # 抠图引擎（首次，Windows 用 scripts\setup_matting.ps1）；ffmpeg 拆 GIF/MP4 需要（macOS: brew install ffmpeg / Windows: winget install ffmpeg）
```

## 两个核心概念

- **素材库**（一级暂存区）：所有图片先在这里落地，做剪裁、抠图、对比确认，满意后再「导入项目」变成帧。素材和项目互不影响，一个素材可导入多个项目。
- **raw / processed**：每个素材（和每帧）都有原图（raw）与加工图（processed，抠图/剪裁产物）两个槽位。导入项目时优先取 processed。

## 设置页（顶栏「设置」）

### 生成 Provider

CLI 与各厂商 API **可配多个共存**，生成时在下拉框里选其中一个。设置页有一排**预设按钮**（OpenAI / 百炼 / banana / MiniMax / 火山方舟（豆包）/ 自定义 CLI / 自定义 API），一键带出类型、Base URL、模型列表和尺寸格式，通常只需填 API Key：

- **CLI provider**：本地命令，**结构化字段免模板**——填命令（PATH 名或绝对路径）、prompt 参数名（如 `--prompt`，留空则 prompt 作位置参数）、输出参数名（如 `-o`）；可选模型参数名（生成弹窗选了模型才下发）、引用图参数名（留空表示该 CLI 不支持引用图）、额外固定参数（原样追加）。服务端按此组装 argv 直接执行，不经 shell。
- **API provider（OpenAI 兼容）**：OpenAI 官方（gpt-image 系列）、火山方舟豆包 Seedream（`https://ark.cn-beijing.volces.com/api/v3`）、各类兼容网关。文生图走 `images/generations`；**选了引用图自动改走 `images/edits`**（需模型支持，如 gpt-image 系列；dall-e-3 不支持 edits 会在任务里报错）。测试连接实发 `GET {baseUrl}/models`。
- **百炼 provider（DashScope 原生）**：阿里云百炼的 qwen-image 系列（文生图 / 图像编辑）**不在 OpenAI 兼容模式内**，必须选这个类型。Base URL 填 `https://dashscope.aliyuncs.com` 或工作区子域 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com`，模型如 `qwen-image-2.0-pro` / `qwen-image-edit-max`，尺寸为星号格式（如 `2048*2048`）。引用图以 base64 随请求上送，原生支持。
- **banana provider（Gemini 图像）**：nano-banana（`gemini-2.5-flash-image`、`gemini-3-pro-image-preview` 等）。Base URL 填 `https://generativelanguage.googleapis.com`，尺寸填宽高比（如 `16:9`）。引用图原生支持（inlineData base64）。测试连接实发 `GET /v1beta/models`。
- **MiniMax provider**：`image-01`。Base URL 填 `https://api.minimaxi.com`，尺寸填宽高比。引用图走 `subject_reference`（主体特征保持，限一张，适合角色一致性）。

测试连接用表单当前值探测，不用先保存；百炼 / MiniMax 没有轻量探测端点，只做字段校验（生成失败会以任务错误形式暴露）。

### 提示词加强模型

「优化提示词」按钮用的模型在这里添加（OpenAI 兼容 `chat/completions`：OpenAI / 百炼兼容模式 qwen / DeepSeek 等均可，如 `gpt-4o-mini`、`qwen-plus`）。加强用的提示词模板内置固定（像素画方向），不需要你写任何模板。

生成弹窗里点 **优化提示词** 后，**原提示词和优化后提示词并排展示**，各自带「用这个」按钮——原文永远不会被自动覆盖，你可以随时切换或关闭对比。配了多个加强模型时按钮旁可下拉选择用哪个。

列表为空时，环境变量 `FRAMEBAKER_GEN_CLI` 会兜底成一个「环境变量 CLI」provider。**设置页配置优先于所有环境变量**，改动即时生效（不用重启）。

### 抠图

- **自定义 CLI 模板**：占位符 `{input}` `{output}`（可选 `{model}`）；留空走自动探测（内置 `.venv-matting` → PATH rembg → 原样复制兜底）。
- **默认模型**：输入框带常用模型建议（u2net / u2netp / isnet-general-use / isnet-anime / birefnet-general 等，也可自由输入）。旁边显示当前生效模型与**缓存状态**——未缓存的模型首次抠图时自动下载（约百 MB，耗时较长，属正常现象）。

### 体检（Doctor）

打开设置页自动跑一遍，也可手动「重新检查」。逐项检查：

- 存储目录可写
- ffmpeg（GIF/MP4 拆帧依赖）
- 抠图引擎（自定义 CLI 校验命令是否存在；rembg 显示来源）
- 抠图模型缓存状态
- 每个生成 provider 单独一项（CLI 校验命令存在；API 实发联通测试）

## 素材库页

### 上传素材

支持多选混合：PNG/JPG 各成 1 个素材；GIF/MP4 拆帧成多个素材（fps 可调）。

**剪裁确认**：选了静态图片后会问「N 张图片，导入前需要剪裁吗？」——

- **逐张剪裁**：依次打开剪裁工具处理每张（可随时「跳过本张」）
- **不需要，直接导入**：全部按原图上传
- 列表里每张图片还有单独的 ✂ 按钮可随时（重新）剪裁；裁过的显示「已剪裁」标记

剪裁在浏览器内完成（Web Worker，不卡 UI），确认后才上传。GIF/MP4 不参与剪裁。

### 生成素材

填提示词、数量（1–16），可选引用图（用某素材或项目帧作为参考），然后选 **Provider / 模型**：

- API 系 provider：模型从其模型列表下拉选（列表为空则手填）
- CLI provider：模型输入框的值按设置的「模型参数名」下发（未配该参数名则忽略）
- 引用图支持：CLI 模板需含 `{reference}`；API 走 `images/edits`（需 gpt-image 系列等支持编辑的模型）；百炼 / banana / MiniMax 原生直接支持（MiniMax 为主体特征保持）

「抠图去背」开关默认勾选，生成/上传完成后自动入队抠图。

### 剪裁工具

为像素图设计：整数像素框选、拖动移动、八向手柄缩放、X/Y/宽/高 数字精调、滚轮缩放（锚定光标）、Alt/中键平移、放大到 800% 后显示像素网格、「自动透明边」一键框选非透明区域（适合裁掉 sprite 周围空白）、「全图」一键重置。确认后输出 PNG。

### 二次加工（选中素材）

不是所有图都需要加工，所以加工都是按需触发：

- **详情弹窗**（点卡片）：原图/抠图后**对比滑杆**验收效果；执行抠图 / 还原原图 / **剪裁**（作用于当前显示图，已抠图则裁抠图后）/ 导入项目（可选复制 1–16 份）/ 删除
- **批量操作**（Cmd/Ctrl+点击多选、Shift+点击范围选）：批量抠图（入队处理）、批量导入项目、批量删除

卡片右下状态点：绿=已抠图，灰=原图。

## 项目编辑器

- **导入**（三 Tab）：素材库（多选，按点选顺序追加到时间轴末尾）/ 上传文件（同样有剪裁确认）/ 生成（同素材库生成，直接成帧）
- **帧列表 + 画布**：PixiJS 画布拖拽帧改位置（offset）；洋葱皮（前帧红 / 后帧蓝）；网格；25–400% 缩放；替换图片；帧时长；关键帧星标
- **时间轴**：拖拽换序；Cmd/Ctrl、Shift 多选后批量删除 / 复制 / 统一时长
- **播放预览**：1–24 fps，每帧停留 duration 个 tick
- **导出精灵表**：纯前端拼合，下载 `*.spritesheet.png` + `*.json`（含每帧 x/y/w/h/duration）
- 布局：帧列表宽度、时间轴高度可拖分隔条调整（双击复位，自动持久化）；主题三态（跟随系统/浅色/深色）

## 常见问题

- **第一次抠图很慢？** 正常，rembg 在下载模型（约百 MB）到 `storage/models`，之后秒级。设置页可看缓存状态。
- **抠图没生效？** 看设置页体检：没装引擎时会退化为「原样复制」并给出安装提示（`./scripts/setup_matting.sh`，Windows 用 `scripts\setup_matting.ps1`）。
- **生成任务失败？** 任务卡片上的错误信息会直接说明（provider 未配置/未选模型/API 返回错误等）；设置页「测试连接」可先排障。
- **GIF 拆帧**会忽略帧延迟，统一按 1 tick；任务队列在内存中，重启服务会丢未完成任务；应用无鉴权，仅适合本地使用。

## 提示与约定

- 全局通知在底部居中弹出（4 秒自动消失，点击立即关）；删除等危险操作都是像素风确认框。
- 所有页面变更（任务进度、抠图完成、他人操作）经 WebSocket 实时刷新，不用手动刷新页面。
