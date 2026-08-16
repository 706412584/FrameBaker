import { describe, expect, test } from "bun:test";
import {
  BUILTIN_HUMANOID_BONE_IDS,
  BUILTIN_HUMANOID_ROOT_ID,
  BUILTIN_HUMANOID_SKELETON_ID,
} from "../packages/shared/src";
import { localizeBoneName, localizeSkeletonName } from "../apps/web/src/builtinAnimationLabels";
import { en } from "../apps/web/src/i18n/en";
import { zh } from "../apps/web/src/i18n/zh";

const translate = (dictionary: Record<string, string>) => (key: string) => dictionary[key] ?? key;

describe("内置骨架显示名称国际化", () => {
  test("内置骨架与关节按当前语言显示", () => {
    expect(localizeSkeletonName(BUILTIN_HUMANOID_SKELETON_ID, "stored", translate(zh))).toBe("内置 · 人形骨架");
    expect(localizeSkeletonName(BUILTIN_HUMANOID_SKELETON_ID, "stored", translate(en))).toBe("Built-in · Humanoid Skeleton");
    expect(localizeBoneName(BUILTIN_HUMANOID_SKELETON_ID, BUILTIN_HUMANOID_ROOT_ID, "stored", translate(zh))).toBe("根节点");
    expect(localizeBoneName(BUILTIN_HUMANOID_SKELETON_ID, BUILTIN_HUMANOID_BONE_IDS.leftShoulder, "stored", translate(en))).toBe("Left Shoulder");
  });

  test("自定义名称和未知内置关节保持原文", () => {
    expect(localizeSkeletonName("custom-skeleton", "我的骨架", translate(en))).toBe("我的骨架");
    expect(localizeBoneName("custom-skeleton", BUILTIN_HUMANOID_ROOT_ID, "自定义根", translate(en))).toBe("自定义根");
    expect(localizeBoneName(BUILTIN_HUMANOID_SKELETON_ID, "future-bone", "Future Bone", translate(zh))).toBe("Future Bone");
  });
});
