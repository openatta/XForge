// design: rule-files §5.3 — 交给外部进程的环境：控制面自己的变量一律剥掉。
/**
 * 控制面留给自己的环境变量前缀。`XFORGE_AUDIT_HMAC` 是给审计事件盖章的密钥，
 * 也是 `inspect` 判断事件有没有被伪造的唯一依据（`RF-25`）——
 * 把它交给门命令或 MCP 审批者，等于把防伪的钥匙交给被治理的那一方。
 *
 * 门命令是项目声明的 shell、MCP 审批者是外部进程：两者都不该看见 `XFORGE_*`。
 */
const PREFIX = 'XFORGE_';

/** 剥掉 `XFORGE_*` 之后的环境，给要 spawn 出去的进程用。 */
export function externalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith(PREFIX)) out[k] = v;
  return out;
}
