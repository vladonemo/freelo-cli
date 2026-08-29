/**
 * `freelo taskchecks finish` (M03, spec 0066).
 *
 * Thin re-export of the shared transition logic — `taskchecks reopen` shares
 * the same surface and (modulo verb, wire path and target state) the same flow.
 * Mirrors `src/commands/tasks/finish.ts`.
 */
export { registerFinish as register } from './transition.js';
export { registerFinish } from './transition.js';
