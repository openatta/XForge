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
 *
 * `moduleContract` is the exception, and the reason it is one is the reason it was wrong here.
 *
 * "An unanswered flag claims nothing" is a sound default only where answering it wrongly is caught
 * somewhere else: a wrong `risk` is refused by Flow eligibility, a wrong `security` by the Gate that
 * scans, a wrong `dataMigration` by the migration paths the Change does not declare. `checker.ts`
 * says what is different about this one -- it is the only eligibility key nothing else can
 * corroborate, and `contract-compat`, the one check that compares the word with the diff, is a
 * `builtin: declared` Gate no default project has selected. So `false` here is not "claims
 * nothing": it is the answer that switches off the whole contract layer, offered pre-written, to
 * the one question no later Stage can re-ask.
 *
 * Three live runs of `solid` and `major` archived with `moduleContract: false` and a null contract
 * baseline. Nothing about that was a defect -- those fixtures are single-module and the answer was
 * true -- but nothing in any of them was an answer either, and there is no run in which it was.
 * A placeholder makes the file refuse to load until somebody says, which is the only shape that
 * has ever changed what an Agent does: not another sentence telling it to consider the question,
 * but a Change that does not exist until the question is answered.
 */
const CLASSIFICATION_PLACEHOLDERS: Required<Record<ClassificationKey, string>> = {
  risk: 'medium',
  security: 'false',
  privacy: 'false',
  publicApi: 'false',
  dataMigration: 'false',
  moduleContract: '<true|false>',
};

/**
 * The question each placeholder stands for, kept beside the placeholder it belongs to.
 *
 * The refusal reads from here rather than restating the semantics, which are also in
 * `xforge-propose`: two copies of "what does this key mean" is exactly the drift the
 * `create-change` Action was extracted to end.
 */
export const CLASSIFICATION_QUESTIONS: Partial<Record<ClassificationKey, string>> = {
  moduleContract: 'It is true when this Change moves an interface between modules — a signature, an endpoint, or a stored shape another module reads. It is not `publicApi`, and a rename behind a module boundary is neither.',
};

/**
 * Recognises a classification value that is still the template's, so the refusal can say so.
 *
 * Keyed on the leading `<` rather than on the exact placeholder text: the same shape marks
 * `paths` and `<change-id>`, and a reader who edits the wording of one should not silently turn
 * off the check that reads it. A value that is any other string is a different mistake -- quoting
 * a boolean, most likely -- and the caller distinguishes them.
 */
export function isUnansweredPlaceholder(value: unknown): value is string {
  return typeof value === 'string' && value.trimStart().startsWith('<');
}

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
