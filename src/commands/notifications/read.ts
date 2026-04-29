/**
 * `freelo notifications read` (R28, spec 0040).
 *
 * Thin re-export of the shared mark logic. The orchestration lives in
 * `./mark.ts` because `notifications unread` shares the same surface and
 * (modulo verb / wire path) the same flow.
 */
export { registerRead as register } from './mark.js';
export { registerRead } from './mark.js';
