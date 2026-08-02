/** 统一的外部命令执行器：捕获 stderr，非零退出即抛错 */
export async function runCmd(argv: string[], env?: Record<string, string>): Promise<void> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : undefined,
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    throw new Error(`命令执行失败 (${argv[0]}): ${stderr.trim().slice(-2000) || `退出码 ${code}`}`);
  }
}
