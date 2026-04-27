/**
 * `freelo tasks reopen` (R11, spec 0021).
 *
 * Thin re-export of the shared transition logic. See `./transition.ts` for
 * the orchestration. The CLI verb is `reopen`; the wire endpoint is
 * `/task/{id}/activate` (the OpenAPI calls it "activate", but `reopen` reads
 * better in the CLI and avoids ambiguity with the project-activate endpoint
 * which is undelete — OpenAPI :649).
 */
export { registerReopen as register } from './transition.js';
export { registerReopen } from './transition.js';
