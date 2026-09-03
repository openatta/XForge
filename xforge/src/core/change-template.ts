import type { ChangeConfig } from '../types.js';

/**
 * The shape of a `change.yaml`, stated by the product rather than copied into a Skill.
 *
 * Creating a Change is the one step of a governed Flow that no Action described. Every other step
 * is a typed `nextAction` carrying its own `writes`, `requiredSections` and `doneWhen`; this one
 * was a YAML block pasted into `xforge-propose` and maintained by hand, and the maintenance failed
 * in the way hand-maintained copies fail. `moduleContract` shipped fully wired — `change.schema.json`
 * defines it, `checker.ts` reads it, all three shipped Flows declare `contractImpact: forbidden` —
 * and could never fire, because the only Skill that writes `change.yaml` never named the key. A
 * test now compares the Skill against the schema, which closed that instance and left the shape
 * living in prose.
 *
 * Here it is a value the CLI hands over, so the Skill can stop carrying it at all.
 *
 * `Required<>` over the classification keys is the drift guard, and it is a compile error rather
 * than a test: adding a key to `ChangeConfig['classification']` without adding it here does not
 * build. `moduleContract` is optional on the type only so a `change.yaml` written before contracts
 * existed still parses; a *new* Change is always offered every key, because a key an author never
 * sees is a key answered by its default.
 */
type ClassificationKey = keyof ChangeConfig['classification'];

/**
 * What each key is offered as, and why that value rather than a blank.
 *
 * Placeholders, not recommendations. `risk: medium` is the value that forces a decision: `low`
 * would be adopted unread and would quietly qualify a Change for `quick`, and `high` mandates
 * `major` by policy. The booleans are `false` because an unanswered flag has to be the one that
 * claims nothing — a template that pre-declared `security: true` would put every Change on Major.
 */
const CLASSIFICATION_PLACEHOLDERS: Required<Record<ClassificationKey, string>> = {
  risk: 'medium',
  security: 'false',
  privacy: 'false',
  publicApi: 'false',
  dataMigration: 'false',
  moduleContract: 'false',
};

/**
 * The template, with the project's own facts substituted where the project has them.
 *
 * The default Flow and the first declared module are real values from this project rather than
 * placeholders: they are the two fields an author is most likely to accept unread, so a wrong
 * guess there is the one that travels furthest. `paths` stays a placeholder because nothing but
 * the work itself can say what this Change touches.
 */
export function changeTemplate(defaultFlow: string, modules: readonly string[]): string {
  const lines = [`flow: ${defaultFlow}`, 'classification:'];
  for (const [key, value] of Object.entries(CLASSIFICATION_PLACEHOLDERS)) lines.push(`  ${key}: ${value}`);
  lines.push('scope:', `  modules: [${modules[0] ?? 'root'}]`, '  paths: [<project-relative glob>]');
  return `${lines.join('\n')}\n`;
}

/** Every classification key, for callers that state them rather than render them. */
export const CLASSIFICATION_KEYS = Object.keys(CLASSIFICATION_PLACEHOLDERS) as ClassificationKey[];
