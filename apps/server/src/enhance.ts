import {
  ENHANCE_STYLES,
  type EnhancePromptIntent,
  type EnhancePromptRequest,
  type EnhancePromptResponse,
} from "@framebaker/shared";
import { resolveEnhancer, resolveEnhancerRuntime, type EnhancerRuntime } from "./provider";

// 加强用的系统提示词由这里按风格组装，用户无需手写任何模板

/** 把真实生成失败中总结出的骨骼素材约束，只注入对应的生成阶段。 */
function buildSkeletalGuidance(intent?: EnhancePromptIntent): string {
  if (!intent) return "";

  const shared = `
- 这是骨骼动画生产素材，不只是好看的概念图；把下列结构约束明确写进英文结果，不能为了丰富画面而删除
- 若用户的披风、长裙、长发、持械姿势或复杂构图会遮挡关节或粘连部件，保留角色创意，但主动改写姿势、遮挡和构图以确保素材可拆分、可绑定、可动画`;

  switch (intent) {
    case "skeletal-character":
      return `${shared}
- 只生成 exactly one full-body character，正面或近正面 neutral T-pose，头到脚完整可见，角色四周留空
- 双手空置；如有武器，将它作为 separate prop 放在角色一侧并与身体至少相隔一个头宽；双臂、双腿、肘和膝必须完整清晰、彼此分开且无遮挡
- 禁止披风、裙摆、长发或武器跨过关节
- 明确排除 parts sheet、multiple characters、multiple poses、cropped body、held weapon 和复杂背景`;
    case "skeletal-parts":
    case "skeletal-decompose":
      return `${shared}
- 输出 strict 4x3 character parts sheet，固定从左到右逐行排列：row 1 head, torso, pelvis, weapon；row 2 upper-arm-left, forearm-left, upper-arm-right, forearm-right；row 3 thigh-left, shin-left, thigh-right, shin-right
- 每格 exactly one isolated complete part，四周留安全边距；任何可见像素不得跨 cell boundary；部件不得接触、重叠、重复或缺失
- 只能输出短关节段，禁止 whole arm 或 whole leg；weapon 必须独占第一行最右格并与身体至少相隔约一个头宽
- 严格保持参考角色的 identity, body proportions, outfit, palette, pixel density, lighting and facing；禁止重新设计、文字、标签、网格装饰或完整人物
${intent === "skeletal-decompose" ? "- 参考图即使已经像分件表，也只提取目标十二部件，禁止 recursive parts sheet 或在单格内再次生成小型分件表" : "- 这是单层分件表，禁止在任意单格内再次生成小型分件表"}`;
    case "skeletal-repair-part":
      return `${shared}
- 只输出用户指定的 one missing or incorrect body part；禁止完整人物、完整分件表或任何其他部件
- 严格保持参考图的 pixel density, lighting, silhouette, proportions and facing
- 关节端保留少量可重叠连接区，但不得附带相邻肢体；部件完整可见、孤立且四周留空`;
    case "motion-clip":
      return `${shared}
- 结果开头先用紧凑短语写齐动作与生产约束，再写风格细节；不要逐帧展开四肢角度或冗长镜头描述
- 严格保持 character identity, bone lengths, body proportions, outfit, facing, pixel density and weapon；禁止肢体伸缩、换边、闪烁、形变或无意的 root drift
- 一次攻击必须清晰分为 preparation/wind-up, contact/hit, recovery；动作连续，根节点位移受控，角色始终留在画面内
- 武器始终保持正确的 hand/socket attachment，不得复制、消失或穿过身体；相机、背景和朝向保持不变，除非用户明确要求
- 循环动作要求 seamless first/last-frame continuity；一次性攻击只能完成一次，禁止错误重复多次`;
  }
}

/** 按所选风格组装系统提示词（未知 style 回退 pixel） */
export function buildEnhanceSystem(
  style?: string,
  mediaKind: "image" | "video" = "image",
  intent?: EnhancePromptIntent,
): string {
  const s = ENHANCE_STYLES.find((x) => x.id === style) ?? ENHANCE_STYLES[0];
  const focus = mediaKind === "video"
    ? "补充动作的起承转合与时间顺序、镜头运动、节奏和角色一致性；要求运动连续，避免闪烁、跳变、形体漂移"
    : "补充主体外观细节、动作姿态、构图、视角、背景、配色与氛围；适合抠图时可加 plain solid background / isolated subject";
  return `你是游戏美术提示词专家。把用户简短的画面描述改写成适合${mediaKind === "video" ? "视频" : "图像"}生成模型的英文提示词。要求：
- 严格保留用户原意（主体、动作、数量），只做丰富与具象化
- 风格方向：${s.directive}；${focus}
${buildSkeletalGuidance(intent)}
- 固定结构与生产约束放在结果开头，装饰性风格细节放在末尾
- 只输出改写后的提示词本身：单行英文，目标不超过 600 个英文字符，绝不超过 700 个；不要思考过程、解释、引号、Markdown 或任何前缀`;
}

/** 兼容会泄露思考标签或 Markdown 的推理模型，保证下游只收到单行生成提示词。 */
function normalizeEnhancedPrompt(content: string): string {
  const withoutReasoning = content
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, " ")
    .replace(/```(?:\w+)?/g, " ");
  const singleLine = withoutReasoning
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:enhanced prompt|prompt)\s*:\s*/i, "")
    .trim();
  const quoted = singleLine.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
  const normalized = (quoted?.[1] ?? quoted?.[2] ?? singleLine).trim();
  if (normalized.length <= 700) return normalized;
  const clipped = normalized.slice(0, 700);
  const lastDelimiter = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("; "), clipped.lastIndexOf(", "));
  if (lastDelimiter >= 600) return clipped.slice(0, lastDelimiter).trim();
  const lastSpace = clipped.lastIndexOf(" ");
  return (lastSpace >= 600 ? clipped.slice(0, lastSpace) : clipped).trim();
}

/** 按 providerType 拼接各厂商 OpenAI 兼容 chat/completions 端点 */
function chatCompletionsUrl(rt: EnhancerRuntime): string {
  switch (rt.providerType) {
    case "gemini": return `${rt.baseUrl}/v1beta/openai/chat/completions`;
    case "minimax": return `${rt.baseUrl}/v1/chat/completions`;
    default: return `${rt.baseUrl}/chat/completions`; // api / dashscope（baseUrl 已含 compatible-mode/v1）
  }
}

/** 调用用户配置的加强模型（OpenAI 兼容 chat/completions）优化生图提示词 */
export async function enhancePrompt(req: EnhancePromptRequest): Promise<EnhancePromptResponse> {
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error("提示词不能为空");
  const enhancer = resolveEnhancer(req.enhancerId);
  if (!enhancer) throw new Error("未配置提示词加强模型：请到「设置」页添加");
  const runtime = resolveEnhancerRuntime(enhancer);
  if (!runtime) {
    throw new Error(`加强模型「${enhancer.name}」配置不完整（Base URL / API Key / 模型）`);
  }

  const request = () => fetch(chatCompletionsUrl(runtime), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${runtime.apiKey}`,
    },
    body: JSON.stringify({
      model: runtime.model,
      messages: [
        { role: "system", content: buildEnhanceSystem(req.style, req.mediaKind, req.intent) },
        { role: "user", content: prompt },
      ],
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  let res: Response;
  try {
    res = await request();
    // 408 表示上游已明确终止本次生成；短暂等待后只重试一次，其他未知网络错误不盲重试。
    if (res.status === 408) {
      await Bun.sleep(300);
      res = await request();
    }
  } catch (e) {
    throw new Error(`加强模型请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`加强模型返回 ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = json.choices?.[0]?.message?.content;
  const enhanced = content ? normalizeEnhancedPrompt(content) : "";
  if (!enhanced) throw new Error("加强模型响应缺少 choices[0].message.content");
  return { enhanced, enhancerName: enhancer.name };
}
