import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import type { AuditEvent, ProjectContext } from '../../types.js';
import { XForgeError, diagnostic } from '../errors.js';
import { sha256, stableStringify } from '../hash.js';

/**
 * What makes the audit chain evidence rather than a log.
 *
 * Each event carries the hash of its predecessor, so the chain detects any rewrite of its own
 * history -- but every input to that hash is public and lives in the repository, which makes it
 * corruption-evident and not tamper-evident. An HMAC over the same body, keyed by a secret from
 * outside the repository, is what closes that gap, and declaring one is a project's opt-in.
 *
 * The three-way verdict matters more than it looks. "Signed and correct", "not signed", and "signed
 * but this environment holds no secret" are different facts, and folding the third into either of
 * the others is how a reader ends up trusting a chain nobody could check.
 */

export function eventHash(event: Omit<AuditEvent, 'hash'>): string {
  return sha256(stableStringify(event));
}

/* ------------------------------------------------------------------ optional HMAC anchor */
/**
 * An audit event as it is written to disk. `hmac` is present only when the project declares
 * `audit.chain.hmacSecretEnv`; it is not part of `AuditEvent` because the default posture does not
 * have it, and because every reader must keep working on a chain that does not carry it.
 */
type SignedAuditEvent = AuditEvent & { hmac?: string };
/**
 * Why an *optional* keyed anchor exists at all.
 *
 * `eventHash` is an unkeyed sha256 and `auditIndexDigest` is a self-consistency check, so both are
 * computable by anyone holding the repository — which, for an agent-driven product, is everyone the
 * chain is meant to attest. That makes the default chain corruption-evident (an edit that forgets to
 * recompute a hash is caught) but not tamper-evident (an edit that recomputes it is not). XForge's
 * default posture is honest-agent governance and that trade is deliberate: the chain's job is to
 * make an accidental or careless rewrite impossible to hide, not to defend against the operator.
 *
 * Teams that need the stronger property declare `audit.chain.hmacSecretEnv` in the manifest, naming
 * an environment variable — the same indirection `audit.remote.hmacSecretEnv` already uses for
 * remote delivery, so a secret is never written into a tracked file. When it is set, every appended
 * event and every committed index carries an HMAC over its unsigned body, and forging either
 * requires the secret rather than just the repository.
 *
 * Every failure mode fails *closed*. A chain written with a secret and read without one is reported
 * as unverifiable rather than silently downgraded to the unkeyed check, an unsigned event inside a
 * signed chain is reported as missing its signature, and appending to a chain whose declared secret
 * is absent from the environment refuses rather than writing an event nobody can later verify.
 */
export interface ChainSigner {
  /** The declared environment variable name, or null when the project declares no chain secret. */
  env: string | null;
  /** The secret read from that variable; null when declared but absent from this environment. */
  secret: string | null;
  configured: boolean;
}
/**
 * `audit.chain` is read structurally rather than off the `Manifest` type: the declaration is opt-in
 * and additive, and this file must keep compiling and behaving identically for every project that
 * does not use it.
 */
export function chainSigner(project: ProjectContext): ChainSigner {
  const env = (project.manifest.audit as { chain?: { hmacSecretEnv?: string } } | undefined)?.chain?.hmacSecretEnv ?? null;
  const value = env ? process.env[env] : undefined;
  return { env, secret: value && value.length > 0 ? value : null, configured: env !== null };
}
export function signBody(secret: string, body: unknown): string {
  return createHmac('sha256', secret).update(stableStringify(body)).digest('hex');
}
function sameSignature(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
/**
 * - `ok`: signed and verified, or unsigned in a project that declares no chain secret.
 * - `missing`: the project signs its chain but this record carries no signature.
 * - `invalid`: the signature does not match the record.
 * - `unverifiable`: the record is signed but this environment holds no secret to check it with.
 */
export type SignatureVerdict = 'ok' | 'missing' | 'invalid' | 'unverifiable';
export function verdictFor(signer: ChainSigner, hmac: string | undefined, body: unknown): SignatureVerdict {
  if (!signer.configured) return hmac === undefined ? 'ok' : 'unverifiable';
  if (signer.secret === null) return 'unverifiable';
  if (hmac === undefined) return 'missing';
  return sameSignature(hmac, signBody(signer.secret, body)) ? 'ok' : 'invalid';
}
/** The signed content of an event: everything except the two fields derived from it. */
export function unsignedBody(event: AuditEvent): Omit<AuditEvent, 'hash'> {
  const { hash: _hash, hmac: _hmac, ...body } = event as SignedAuditEvent;
  return body;
}
export function eventSignature(signer: ChainSigner, event: AuditEvent): SignatureVerdict {
  return verdictFor(signer, (event as SignedAuditEvent).hmac, unsignedBody(event));
}
export function signatureDiagnostic(verdict: SignatureVerdict, signer: ChainSigner, subject: string, eventId?: string): { code: string; message: string; eventId?: string } {
  const where = eventId ? { eventId } : {};
  if (verdict === 'invalid') return { code: 'XFORGE_AUDIT_HMAC_INVALID', message: `${subject} HMAC does not match its content.`, ...where };
  if (verdict === 'missing') return { code: 'XFORGE_AUDIT_HMAC_MISSING', message: `${subject} carries no HMAC, but this project signs its audit chain (audit.chain.hmacSecretEnv: ${signer.env}).`, ...where };
  return {
    code: 'XFORGE_AUDIT_HMAC_UNVERIFIABLE',
    message: signer.env
      ? `${subject} is signed but ${signer.env} is not set in this environment, so the audit chain cannot be verified.`
      : `${subject} is signed but this project declares no audit.chain.hmacSecretEnv, so the audit chain cannot be verified.`,
    ...where,
  };
}
/** Adds the chain hash and, when the project signs its chain, the HMAC over the same body. */
export function sealEvent(signer: ChainSigner, unsigned: Omit<AuditEvent, 'hash'>): SignedAuditEvent {
  const hash = eventHash(unsigned);
  if (!signer.configured) return { ...unsigned, hash };
  if (signer.secret === null) {
    throw new XForgeError(
      diagnostic('XFORGE_AUDIT_CHAIN_SECRET_MISSING', `This project signs its audit chain, but ${signer.env} is not set in this environment.`, 'xforge/manifest.yaml'),
      {
        nextActions: [{
          action: `Export ${signer.env} before running commands that record audit events`,
          reason: 'Appending an unsigned event to a signed chain would leave a record that no later verification can accept, so the append refuses instead.',
          type: 'maintenance',
        }],
      },
    );
  }
  return { ...unsigned, hmac: signBody(signer.secret, unsigned), hash };
}
/**
 * Local chain events an attestation may be read from.
 *
 * With no chain secret declared this is the identity function, which is what keeps the default
 * posture unchanged. With one declared, an event whose HMAC does not verify — or cannot be verified
 * here — is not evidence of anything, so it is dropped rather than believed. Callers deliberately
 * keep the *unfiltered* list for their "is there any audit data at all?" tests: filtering an
 * unverifiable chain down to nothing must never look like a project that never had a chain, because
 * that would turn a fail-closed check into a fail-open one.
 */
export function attestableEvents(signer: ChainSigner, events: AuditEvent[]): AuditEvent[] {
  if (!signer.configured) return events;
  return events.filter((event) => eventSignature(signer, event) === 'ok');
}

/* ------------------------------------------------------------------ anchors */
