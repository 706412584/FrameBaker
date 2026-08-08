# FrameBaker Animation Schemas

这些 JSON Schema 使用 Draft 2020-12，描述 FrameBaker 通用动画资产与 `.fbanim` 清单的公开线格式。

- 已发布的版本目录不可原地修改；任何可接受数据形状的变化都新建版本。
- Skeleton、MotionClip 与 `.fbanim` packageVersion 独立演进。
- Schema 负责结构检查；四元数归一化、骨架无环、时间边界、引用闭包和摘要等语义仍必须通过 `@framebaker/shared` 运行时校验。
- JSON 文件使用 RFC 8785 规范编码；资产摘要基于未压缩的规范 UTF-8 字节。
- `$id` 与跨文件 `$ref` 使用稳定 URN，发布时必须连同完整版本目录一起分发。
- 不支持的核心字段必须拒绝；第三方数据只能放在反向域名命名的 `extensions` 中。

当前 v1 只发布 `Skeleton`、`MotionClip` 和逻辑 `.fbanim` manifest。ZIP 是传输层，不改变这些 schema 或内容摘要。
