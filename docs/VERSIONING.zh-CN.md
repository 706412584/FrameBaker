# FrameBaker 版本规则

main 分支发布采用兼容 SemVer 数字格式的 `MAJOR.WEEK.BUG`：

- `MAJOR`：不兼容的大版本，人工决定何时提升。
- `WEEK`：当前大版本内连续递增的开发周序号，从 1 开始；它不是 ISO 自然周，因此不会在跨年时从 52 回退到 1。
- `BUG`：当前开发周内的修复发布号，从 0 开始。

## 示例

| 版本 | 含义 |
| --- | --- |
| `0.1.0` | 第 0 大版本，第 1 个开发周的功能基线 |
| `0.1.1` | 第 1 周的第 1 个 Bug 修复版本 |
| `0.2.0` | 下一开发周，Bug 号归零 |
| `1.1.0` | 第 1 个正式大版本，从第 1 周重新计数 |

## main 发布流程

1. 日常变更先写入 `docs/CHANGELOG.md` 和 `docs/CHANGELOG.zh-CN.md` 的 `Unreleased`。
2. 预览版本，不修改文件：

   ```bash
   bun run version:plan -- bug
   bun run version:plan -- week
   bun run version:plan -- major
   ```

3. 发布时选择一种目标：

   ```bash
   bun run version:bump -- bug    # 0.1.0 → 0.1.1
   bun run version:bump -- week   # 0.1.1 → 0.2.0
   bun run version:bump -- major  # 0.2.0 → 1.1.0
   ```

脚本会同步根包、全部 workspace、`bun.lock`、MCP 对外版本、API 文档示例及中英文 changelog。脚本不执行 git commit、tag 或 push。

`patch` 和 `minor` 分别作为 `bug` 和 `week` 的兼容别名；仅在纠正版本数据时才应传完整版本号。
