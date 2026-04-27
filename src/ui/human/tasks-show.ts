import { renderTable } from '../table.js';
import { type TasksShowData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks show <id>`.
 *
 * Spec 0018 §3.4. Renders a header block summarising the task's key
 * metadata, then conditionally appends:
 *   - a `DESCRIPTION` block when `data.description` is present
 *   - a `SUBTASKS` table when `data.subtasks` is present
 *   - a `MULTI-PROJECT MEMBERSHIP` block when `data.projects` is present
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` for the
 * subtasks table.
 */
export async function renderTasksShowHuman(data: TasksShowData): Promise<string> {
  const lines: string[] = [];
  const task = data.task as Record<string, unknown>;

  const id = typeof task['id'] === 'number' ? task['id'] : '?';
  const name = typeof task['name'] === 'string' ? task['name'] : '';
  lines.push(`Task: ${name} (#${id})`);

  const project = task['project'] as Record<string, unknown> | null | undefined;
  if (project && typeof project['id'] === 'number') {
    const pName = typeof project['name'] === 'string' ? project['name'] : '';
    lines.push(`Project:  ${pName} (#${project['id']})`);
  }

  const tasklist = task['tasklist'] as Record<string, unknown> | null | undefined;
  if (tasklist && typeof tasklist['id'] === 'number') {
    const tName = typeof tasklist['name'] === 'string' ? tasklist['name'] : '';
    lines.push(`Tasklist: ${tName} (#${tasklist['id']})`);
  }

  const state = task['state'] as Record<string, unknown> | null | undefined;
  if (state && typeof state['state'] === 'string') {
    lines.push(`State:    ${state['state']}`);
  }

  const worker = task['worker'] as Record<string, unknown> | null | undefined;
  if (worker) {
    lines.push(`Worker:   ${formatUserLabel(worker)}`);
  }

  const author = task['author'] as Record<string, unknown> | null | undefined;
  if (author) {
    lines.push(`Author:   ${formatUserLabel(author)}`);
  }

  const due = formatDateOnly(task['due_date']);
  if (due !== '') lines.push(`Due:      ${due}`);
  const created = formatDateOnly(task['date_add']);
  if (created !== '') lines.push(`Created:  ${created}`);
  const edited = formatDateOnly(task['date_edited_at']);
  if (edited !== '') lines.push(`Edited:   ${edited}`);

  const priority = task['priority_enum'];
  if (typeof priority === 'string' && priority !== '') {
    lines.push(`Priority: ${priority}`);
  }

  const countSubtasks = task['count_subtasks'];
  if (typeof countSubtasks === 'number') {
    lines.push(`Subtasks (count): ${countSubtasks}`);
  }

  const comments = task['comments'];
  if (Array.isArray(comments)) {
    lines.push(`Comments (count): ${comments.length}`);
  }

  const labels = task['labels'];
  if (Array.isArray(labels) && labels.length > 0) {
    const labelNames = labels
      .map((l) => {
        const lbl = l as Record<string, unknown>;
        return typeof lbl['name'] === 'string' ? lbl['name'] : '';
      })
      .filter((s) => s !== '');
    if (labelNames.length > 0) {
      lines.push(`Labels:   ${labelNames.join(', ')}`);
    }
  }

  // Description side-car.
  if (data.description !== undefined) {
    lines.push('');
    lines.push('DESCRIPTION');
    const content = data.description.content;
    lines.push(typeof content === 'string' && content !== '' ? content : '(no description)');
  }

  // Subtasks side-car.
  if (data.subtasks !== undefined) {
    lines.push('');
    lines.push('SUBTASKS');
    if (data.subtasks.length === 0) {
      const empty = await renderTable(
        ['ID', 'NAME', 'STATE', 'WORKER'],
        [['', '(no subtasks)', '', '']],
        { nameColumnIndex: 1 },
      );
      lines.push(empty.trimEnd());
    } else {
      const rows = data.subtasks.map((s) => [
        String(s.id),
        typeof s.name === 'string' ? s.name : '',
        s.state?.state ?? '',
        s.worker?.fullname ?? (s.worker ? String(s.worker.id) : '(none)'),
      ]);
      const table = await renderTable(['ID', 'NAME', 'STATE', 'WORKER'], rows, {
        nameColumnIndex: 1,
      });
      lines.push(table.trimEnd());
    }
  }

  // Projects side-car.
  if ('projects' in data) {
    lines.push('');
    lines.push('MULTI-PROJECT MEMBERSHIP');
    if (data.projects === null || data.projects === undefined) {
      lines.push('(single-project task)');
    } else {
      lines.push(JSON.stringify(data.projects, null, 2));
    }
  }

  return lines.join('\n');
}

function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m?.[1] ?? value;
}

/**
 * Render a user reference as a human-friendly label. Prefers `fullname`,
 * falls back to `#<id>` when only id is present, else empty string.
 *
 * Defensive: avoids the `String({})` -> `[object Object]` footgun by
 * narrowing each field before stringifying.
 */
function formatUserLabel(user: Record<string, unknown>): string {
  if (typeof user['fullname'] === 'string' && user['fullname'] !== '') {
    return user['fullname'];
  }
  if (typeof user['id'] === 'number') {
    return `#${user['id']}`;
  }
  return '';
}
