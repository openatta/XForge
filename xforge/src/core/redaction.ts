/**
 * Output redaction for XForge-spawned subprocesses.
 *
 * Gates and project Scripts are both project-defined commands that XForge runs on the developer's
 * or CI machine, and both receive a filtered — but not empty — environment (`core/env-safety.ts`,
 * and the fixed allowlist in `runners/script.ts`). Their captured output is written into Evidence,
 * audit records, and CLI JSON, all of which get committed or shipped to a reviewer, so anything a
 * child echoes back is durable.
 *
 * This lives here rather than in `runners/gate.ts` because it applied to exactly one of the two
 * runners for no reason anybody could state: `runProjectScript` returned raw stdout/stderr while
 * the Gate runner redacted the same class of output. Sharing the implementation makes the guarantee
 * a property of "XForge captured subprocess output", not of whichever runner happened to have it.
 *
 * It is a best-effort scrub, not a security boundary: it catches `KEY=value` shapes and literal
 * occurrences of the parent process's own credential-shaped variables. A child that base64-encodes
 * a secret before printing it defeats it, and nothing here replaces not handing the secret over in
 * the first place.
 */
export function redact(input: string): string {
  let output = input.replace(/((?:password|passwd|secret|api[_-]?key|(?:access[_-]?)?token|authorization)\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
  for (const [key, value] of Object.entries(process.env)) {
    if (!/(?:password|passwd|secret|api[_-]?key|token)/i.test(key) || !value || value.length < 5) continue;
    output = output.split(value).join('[REDACTED]');
  }
  return output;
}
