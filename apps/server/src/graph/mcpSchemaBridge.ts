// MCP tool Zod schema -> 节点 paramsSchema 的转换器。
// 入参 schema 即参数面板的渲染依据；端口（数据流）仍由 registry 手写，
// 因为 MCP tool 的参数是"值"不是"上游产物引用"。
import * as z from "zod/v4";

type JsonSchema = Record<string, unknown>;

/** zod/v4 自带 toJSONSchema；strict 模式会加 additionalProperties:false，节点参数允许宽松 */
export function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
}

/**
 * 从 MCP tool 的 inputSchema 生成节点参数 schema 骨架。
 * 后续阶段扩展节点时，可用它批量预生成再手工修端口。
 */
export function paramsSchemaFromTool(inputSchema: z.ZodType): JsonSchema {
  const json = zodToJsonSchema(inputSchema);
  // tool 参数里的 id 字段（materialId/jobId 等）在节点里改由连线/节点上下文提供，不进参数面板
  const props = (json.properties ?? {}) as Record<string, JsonSchema>;
  const filtered: Record<string, JsonSchema> = {};
  for (const [key, value] of Object.entries(props)) {
    if (/^(materialId|jobId|projectId|frameId)$/i.test(key)) continue;
    filtered[key] = value;
  }
  return { ...json, properties: filtered };
}
