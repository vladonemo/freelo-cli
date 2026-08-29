/**
 * `freelo taskchecks reopen` (M03, spec 0066).
 *
 * Thin re-export of the shared transition logic. The wire path is
 * `/taskcheck/{id}/activate`; the CLI verb is `reopen` to match R11's
 * `tasks reopen`. Mirrors `src/commands/tasks/reopen.ts`.
 */
export { registerReopen as register } from './transition.js';
export { registerReopen } from './transition.js';
