# FrameBaker Versioning

Main-branch releases use the SemVer-compatible numeric shape `MAJOR.WEEK.BUG`:

- `MAJOR`: manually advanced for an incompatible major release.
- `WEEK`: a monotonically increasing development-week counter within the current major, starting at 1. It is not an ISO calendar week, so it never rolls backward at year boundaries.
- `BUG`: the fix-release counter within the current development week, starting at 0.

## Examples

| Version | Meaning |
| --- | --- |
| `0.1.0` | Major 0, feature baseline for development week 1 |
| `0.1.1` | First bug-fix release during week 1 |
| `0.2.0` | Next development week, bug counter reset |
| `1.1.0` | First stable major, week counter restarted at 1 |

## Main Release Workflow

1. Record daily changes under `Unreleased` in both `docs/CHANGELOG.md` and `docs/CHANGELOG.zh-CN.md`.
2. Preview without writing files:

   ```bash
   bun run version:plan -- bug
   bun run version:plan -- week
   bun run version:plan -- major
   ```

3. Release with one target:

   ```bash
   bun run version:bump -- bug    # 0.1.0 → 0.1.1
   bun run version:bump -- week   # 0.1.1 → 0.2.0
   bun run version:bump -- major  # 0.2.0 → 1.1.0
   ```

The script synchronizes the root package, every workspace, `bun.lock`, MCP-reported version, API documentation examples, and both changelogs. It also regenerates the marker-delimited **Latest Changes** section at the bottom of both READMEs from the two newest released changelog entries; do not edit that generated section manually. It does not commit, tag, or push with git.

`patch` and `minor` remain compatibility aliases for `bug` and `week`; exact versions are reserved for correcting version data.
