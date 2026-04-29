/**
 * `freelo notifications unread` (R28, spec 0040).
 *
 * Thin re-export of the shared mark logic. The orchestration lives in
 * `./mark.ts` because `notifications read` shares the same surface and
 * (modulo verb / wire path) the same flow. Unlike `read`, this command does
 * NOT support `--all-unread` (no API filter for "all read").
 */
export { registerUnread as register } from './mark.js';
export { registerUnread } from './mark.js';
