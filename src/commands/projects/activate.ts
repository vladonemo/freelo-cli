/**
 * `freelo projects activate` (R30, spec 0043).
 *
 * Thin re-export of the shared transition logic. The orchestration lives in
 * `./transition.ts` because `projects archive` shares the same surface and
 * (modulo verb / target state) the same flow.
 */
export { registerActivate as register } from './transition.js';
export { registerActivate } from './transition.js';
