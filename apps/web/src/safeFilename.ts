/** 文件名安全化：去掉路径非法字符 */
export function safeFilename(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, "_").trim() || "material";
}
