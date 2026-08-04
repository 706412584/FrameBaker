# FrameBaker — AGENTS

像素风逐帧动画编辑器（Bun 全栈）。素材导入（GIF/MP4 拆帧、PNG、外部 CLI 生成）→ 帧编辑（PixiJS 洋葱皮）→ 时间轴排序 → 播放预览 → 导出精灵表。

## Monorepo 结构（Bun workspaces）

```
apps/
  server/        @framebaker/server — Elysia API + 任务队列 + bun:sqlite；Bun.serve 托管前端
  web/           @framebaker/web   — React 19 + pixi.js v8 + motion + lucide-react；index.html 是打包入口
packages/
  shared/        @framebaker/shared — 前后端共享类型/常量（无构建，exports 直指 src/index.ts）
docs/            架构 / API / roadmap 文档
storage/         运行时生成（已 gitignore），固定解析到仓库根，与启动 cwd 无关
```

## 常用命令

```bash
bun install          # 安装全部 workspace 依赖（bun 用 isolated 布局，各包有自己的 node_modules）
bun dev              # 开发（--hot），http://localhost:3000，PORT 可覆盖
bun start            # 生产
bun run typecheck    # tsc -p apps/server && tsc -p apps/web，改动后必须通过
```

无测试框架；验证方式 = typecheck + curl 冒烟（见 docs/api.md 的示例）。

## 约定

- **不要执行任何 git 操作**（不 init / commit / push），除非用户明确要求。
- 共享类型、枚举、WS 事件名一律放 `packages/shared`（FRAME_STATUSES / FRAME_SOURCES / JOB_TYPES / WS_EVENTS / SOURCE_COLORS / Frame / FramePatch 等），前后端都从这里导入，不要在 web 里重新定义。
- 后端文件路径必须用 `db.ts` 导出的 `STORAGE_ROOT`（基于 import.meta.dir），禁止依赖 cwd 的相对路径。
- 依赖最小化：不引入新依赖除非确有必要；拖拽用原生 HTML5 DnD，不装 dnd 库；不用 Vite / react-router / drizzle。
- 外部命令（ffmpeg / 生成 CLI / 抠图 CLI）一律走 `apps/server/src/jobs/run.ts` 的 runCmd（Bun.spawn + stderr 捕获），命令模板按空白 split 后替换占位符，禁止拼 shell 字符串。
- UI 文案与代码注释用中文；像素风主题（Fusion Pixel 12 字体、box-shadow 阶梯边框、image-rendering: pixelated），配色为 Cassette Futurism 双主题调色板（深色 Magnetic Night 默认 / 浅色 Beige Terminal），全部走 `apps/web/src/styles.css` 的 CSS 变量（`[data-theme="dark"|"light"]`），不要新增硬编码色值；主题管理在 `apps/web/src/theme.ts`。
- 改动 API 时同步更新 `docs/api.md`；改动架构/目录结构时同步更新 `docs/architecture.md` 与本文件。
- `storage/` 与 `node_modules/` 已 gitignore；smoke test 后清理 storage 与 /tmp 临时文件。

## 环境变量

- `PORT`（默认 3000）
- `FRAMEBAKER_GEN_CLI`：CLI 生成模板，占位符 `{prompt}` `{output}` `{index}` `{reference}`（引用图由前端传 referenceMaterialId/referenceFrameId，服务端按 id 解析路径，模板与引用图不一致在创建 job 时 400）
- `FRAMEBAKER_MATTING_CLI`：自定义抠图模板，占位符 `{input}` `{output}`（可选 `{model}`）；优先于内置 rembg
- `FRAMEBAKER_MATTING_MODEL`：rembg 模型名（默认 `u2net`）；模型缓存在 `storage/models`（U2NET_HOME）
- 抠图引擎：未配 CLI 时用 `scripts/setup_matting.sh` 安装的 `.venv-matting/bin/rembg`（已 gitignore），再次之 PATH rembg，最后 passthrough 复制；探测结果见 `GET /api/config`
