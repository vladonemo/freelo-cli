import { type ProjectsInviteData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects invite`. Spec 0046 §3.5.
 *
 * Live-success line:
 *   `Invited <N people> to <M projects>.`
 * Optional follow-up bullet block listing newly-created users:
 *   `  - <email>  (newly created user, id <id>)`
 *
 * Dry-run variant:
 *   `(dry-run) Would invite <N people> to <M projects> (<by emails / by ids / mixed>).`
 *
 * `<N people>` is derived from envelope inputs (count of `users_ids` plus
 * `emails`) on dry-run, and from the wire result on live (count of
 * `result.newly_invited_users` — the most informative bucket; falls back to
 * input count when zero, e.g. server treated everyone as already-present).
 */
export function renderProjectsInviteHuman(data: ProjectsInviteData): string {
  const projectCount = data.projects_ids.length;
  const inputUsersCount = (data.users_ids?.length ?? 0) + (data.emails?.length ?? 0);

  if (data.would !== undefined) {
    // Dry-run.
    const flavor = describeFlavor(data);
    const peopleSubject = pluralize(inputUsersCount, 'person', 'people');
    const projectsSubject = pluralize(projectCount, 'project', 'projects');
    return `(dry-run) Would invite ${peopleSubject} to ${projectsSubject} (${flavor}).`;
  }

  // Live success. Prefer the wire-result count; fall back to input count.
  const result = data.result;
  const invitedCount = result?.newly_invited_users.length ?? 0;
  const reportedCount = invitedCount > 0 ? invitedCount : inputUsersCount;
  const peopleSubject = pluralize(reportedCount, 'person', 'people');
  const projectsSubject = pluralize(projectCount, 'project', 'projects');

  const head = `Invited ${peopleSubject} to ${projectsSubject}.`;

  // Optional bullet list — only include newly-created users (most useful
  // for human eyes; existing-user re-invites surface only on the JSON
  // envelope where agents read `result.newly_invited_users_to_projects`).
  if (result === undefined || result.newly_created_users.length === 0) {
    return head;
  }
  const lines = result.newly_created_users.map((u) => {
    const email = u.email ?? '(unknown email)';
    const idPart = u.id !== undefined ? `, id ${u.id}` : '';
    return `  - ${email}  (newly created user${idPart})`;
  });
  return `${head}\n${lines.join('\n')}`;
}

function pluralize(n: number, singular: string, plural: string): string {
  return n === 1 ? `1 ${singular}` : `${n} ${plural}`;
}

/**
 * Describe the flavor of the invite for the dry-run summary parenthetical.
 */
function describeFlavor(data: ProjectsInviteData): string {
  const hasUsers = data.users_ids !== undefined && data.users_ids.length > 0;
  const hasEmails = data.emails !== undefined && data.emails.length > 0;
  if (hasUsers && hasEmails) {
    const u = data.users_ids!.length;
    const e = data.emails!.length;
    return `${u} by id, ${e} by email`;
  }
  if (hasUsers) {
    return data.users_ids!.length === 1 ? 'by id' : 'by ids';
  }
  // hasEmails — guaranteed by validateInviteInput; default branch defensive.
  const e = data.emails?.length ?? 0;
  return e === 1 ? 'by email' : 'by emails';
}
