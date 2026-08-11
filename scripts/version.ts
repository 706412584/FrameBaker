import { join } from "node:path";
import { renameSync, rmSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const PACKAGE_FILES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "packages/shared/package.json",
] as const;
const CHANGELOG_FILES = ["docs/CHANGELOG.md", "docs/CHANGELOG.zh-CN.md"] as const;
const API_DOC_FILES = ["docs/api.md", "docs/api.zh-CN.md"] as const;
const WORKSPACE_NAMES = ["@framebaker/server", "@framebaker/web", "@framebaker/shared"] as const;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message: string): never {
  console.error(`错误：${message}`);
  process.exit(1);
}

async function read(path: string): Promise<string> {
  const file = Bun.file(join(ROOT, path));
  if (!(await file.exists())) fail(`文件不存在：${path}`);
  return file.text();
}

function parseVersion(value: string): [number, number, number] {
  const match = SEMVER.exec(value);
  if (!match) fail(`不是合法 SemVer：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: string, b: string): number {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] - bv[i];
  return 0;
}

function nextVersion(current: string, target: string): string {
  if (SEMVER.test(target)) return target;
  const [major, week, bug] = parseVersion(current);
  if (target === "major") return `${major + 1}.1.0`;
  if (target === "week" || target === "minor") return `${major}.${week + 1}.0`;
  if (target === "bug" || target === "patch") return `${major}.${week}.${bug + 1}`;
  fail("目标必须是 bug、week、major 或完整版本号（patch/minor 为兼容别名）");
}

const packageTexts = await Promise.all(PACKAGE_FILES.map(read));
const versions = packageTexts.map((text, i) => {
  const value = (JSON.parse(text) as { version?: unknown }).version;
  if (typeof value !== "string") fail(`${PACKAGE_FILES[i]} 缺少 version`);
  parseVersion(value);
  return value;
});
const current = versions[0];
if (versions.some((version) => version !== current)) {
  fail(`workspace 版本不一致：${PACKAGE_FILES.map((file, i) => `${file}=${versions[i]}`).join(", ")}`);
}

const changelogs = await Promise.all(CHANGELOG_FILES.map(read));
for (let i = 0; i < changelogs.length; i++) {
  if (!changelogs[i].includes(`## [${current}]`)) fail(`${CHANGELOG_FILES[i]} 缺少当前版本 ${current}`);
  if (!changelogs[i].includes("## [Unreleased]")) fail(`${CHANGELOG_FILES[i]} 缺少 Unreleased 区域`);
}

const lockText = await read("bun.lock");
for (const name of WORKSPACE_NAMES) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`"name": "${escapedName}",\\n\\s+"version": "([^"]+)"`).exec(lockText);
  if (!match || match[1] !== current) fail(`bun.lock 中 ${name} 的版本不是 ${current}`);
}

const command = Bun.argv[2] ?? "check";
if (command === "check") {
  console.log(`✓ FrameBaker ${current}：根包、workspace、bun.lock 与 changelog 版本一致`);
  process.exit(0);
}
if (command !== "bump" && command !== "plan") {
  fail("用法：bun run version:check、bun run version:plan -- bug|week|major，或 bun run version:bump -- bug|week|major");
}

const requested = Bun.argv[3];
if (!requested) fail("缺少目标：bug、week、major 或完整版本号");
const next = nextVersion(current, requested);
if (compare(next, current) <= 0) fail(`新版本 ${next} 必须高于当前版本 ${current}`);
if (command === "plan") {
  console.log(`${current} → ${next}`);
  process.exit(0);
}

const releaseDate = new Date().toISOString().slice(0, 10);
const releasedChangelogs = changelogs.map((text, i) => {
  const match = /## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[)/.exec(text);
  if (!match || !match[1].trim()) fail(`${CHANGELOG_FILES[i]} 的 Unreleased 没有变更条目`);
  return text.replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] - ${releaseDate}`);
});

// 所有目标内容先在内存中完成并校验，避免校验失败时只更新一半文件。
const outputs = new Map<string, string>();
for (let i = 0; i < PACKAGE_FILES.length; i++) {
  const pkg = JSON.parse(packageTexts[i]) as Record<string, unknown>;
  pkg.version = next;
  outputs.set(PACKAGE_FILES[i], `${JSON.stringify(pkg, null, 2)}\n`);
}

let nextLock = lockText;
for (const name of WORKSPACE_NAMES) {
  const before = `"name": "${name}",\n      "version": "${current}"`;
  const after = `"name": "${name}",\n      "version": "${next}"`;
  if (nextLock.split(before).length !== 2) fail(`bun.lock 中 ${name} 的版本位置不唯一`);
  nextLock = nextLock.replace(before, after);
}
outputs.set("bun.lock", nextLock);

for (let i = 0; i < CHANGELOG_FILES.length; i++) {
  outputs.set(CHANGELOG_FILES[i], releasedChangelogs[i]);
}
for (const path of API_DOC_FILES) {
  const text = await read(path);
  const before = `"name": "framebaker", "version": "${current}"`;
  if (text.split(before).length !== 2) fail(`${path} 中 MCP 版本示例位置不唯一`);
  outputs.set(path, text.replace(before, `"name": "framebaker", "version": "${next}"`));
}

const staged: Array<{ temp: string; destination: string }> = [];
try {
  for (const [path, content] of outputs) {
    const destination = join(ROOT, path);
    const temp = `${destination}.version-tmp-${process.pid}`;
    await Bun.write(temp, content);
    staged.push({ temp, destination });
  }
  for (const file of staged) renameSync(file.temp, file.destination);
} catch (error) {
  for (const file of staged) rmSync(file.temp, { force: true });
  throw error;
}

console.log(`✓ FrameBaker ${current} → ${next}`);
console.log("已同步 package.json、workspace、bun.lock、API 文档与中英文 changelog；未执行任何 git 操作。");
