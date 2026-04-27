/**
 * `freelo tasks finish` (R11, spec 0021).
 *
 * Thin re-export of the shared transition logic. The orchestration lives in
 * `./transition.ts` because `tasks reopen` shares the same surface and
 * (modulo verb / target state) the same flow.
 */
export { registerFinish as register } from './transition.js';
export { registerFinish } from './transition.js';
