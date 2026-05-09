/**
 * `freelo projects archive` (R30, spec 0043).
 *
 * Thin re-export of the shared transition logic. The orchestration lives in
 * `./transition.ts` because `projects activate` shares the same surface and
 * (modulo verb / target state) the same flow.
 */
export { registerArchive as register } from './transition.js';
export { registerArchive } from './transition.js';
