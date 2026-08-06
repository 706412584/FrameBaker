import type { EnhancePromptRequest, EnhancePromptResponse } from "@framebaker/shared";
import { enhancerConfigured, resolveEnhancer } from "./provider";

// 加强用的系统提示词固定在这里（像素画/游戏 sprite 方向），用户无需手写任何模板

const ENHANCE_SYSTEM = `你是像素画与游戏美术提示词专家。把用户简短的画面描述改写成适合图像生成模型的英文提示词。要求：
- 严格保留用户原意（主体、动作、数量），只做丰富与具象化
- 补充：pixel art 风格、主体外观细节、动作姿态、视角、配色与氛围；适合抠图时可加 plain solid background / isolated subject
- 只输出改写后的提示词本身：单行英文，不要解释、不要引号、不要任何前缀`;

/** 调用用户配置的加强模型（OpenAI 兼容 chat/completions）优化生图提示词 */
export async function enhancePrompt(req: EnhancePromptRequest): Promise<EnhancePromptResponse> {
  const prompt = req.prompt.trim();
  if (!prompt) throw new Error("提示词不能为空");
  const enhancer = resolveEnhancer(req.enhancerId);
  if (!enhancer) throw new Error("未配置提示词加强模型：请到「设置」页添加");
  if (!enhancerConfigured(enhancer)) {
    throw new Error(`加强模型「${enhancer.name}」配置不完整（Base URL / API Key / 模型）`);
  }

  const base = enhancer.apiBaseUrl.trim().replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${enhancer.apiKey.trim()}`,
      },
      body: JSON.stringify({
        model: enhancer.apiModel.trim(),
        messages: [
          { role: "system", content: ENHANCE_SYSTEM },
          { role: "user", content: prompt },
        ],
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    throw new Error(`加强模型请求失败: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`加强模型返回 ${res.status}: ${text}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const enhanced = json.choices?.[0]?.message?.content?.trim();
  if (!enhanced) throw new Error("加强模型响应缺少 choices[0].message.content");
  return { enhanced, enhancerName: enhancer.name };
}
