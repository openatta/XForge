/**
 * The published type surface, as one import.
 *
 * `package.json` points `types` at `dist/index.d.ts`, and `index.ts` ends with `export * from
 * './types.js'` -- so this barrel *is* the type API. It was a single thousand-line module that every
 * one of sixty-five importers reached into for one or two names; splitting it by domain leaves both
 * of those facts untouched, which is the point. A consumer cannot tell, and neither can an importer.
 *
 * A type belongs in the file whose subject it describes. When a new one has no obvious home, that is
 * usually a sign it is describing two subjects at once.
 */
/* The one value in this surface: a narrowing guard that belongs with the union it narrows. */
export { isRetired, isVerificationRun } from './types/manifest.js';

export type * from './types/protocol.js';
export type * from './types/manifest.js';
export type * from './types/flow.js';
export type * from './types/change.js';
export type * from './types/work-package.js';
export type * from './types/resource.js';
export type * from './types/installation.js';
export type * from './types/governance.js';
