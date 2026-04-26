import { renderTable } from '../table.js';
import { type ProjectShowData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects show <id>`.
 *
 * Spec 0013 §3.4. Renders a header block summarising the project's key
 * metadata, then — when `data.workers` is present — appends a table of
 * workers.
 *
 * The renderer is async because it lazy-loads `cli-table3` via `renderTable`
 * for the workers table.
 */
export async function renderProjectsShowHuman(data: ProjectShowData): Promise<string> {
  const lines: string[] = [];
  const project = data.project as Record<string, unknown>;

  const id = typeof project['id'] === 'number' ? project['id'] : '?';
  const name = typeof project['name'] === 'string' ? project['name'] : '';
  lines.push(`Project: ${name} (#${id})`);

  const created = formatDateOnly(project['date_add']);
  if (created !== '') lines.push(`Created: ${created}`);

  const edited = formatDateOnly(project['date_edited_at']);
  if (edited !== '') lines.push(`Edited:  ${edited}`);

  const stateLabel = formatState(project['state']);
  if (stateLabel !== '') lines.push(`State:   ${stateLabel}`);

  const ownerLabel = formatOwner(project['owner']);
  if (ownerLabel !== '') lines.push(`Owner:   ${ownerLabel}`);

  const budgetLabel = formatCurrency(project['budget']);
  if (budgetLabel !== '') lines.push(`Budget:  ${budgetLabel}`);

  const spentLabel = formatSpent(project['real_cost'], project['real_minutes_spent']);
  if (spentLabel !== '') lines.push(`Spent:   ${spentLabel}`);

  const tasklists = project['tasklists'];
  if (Array.isArray(tasklists)) {
    lines.push(`Tasklists: ${tasklists.length}`);
  }

  const embeddedWorkers = project['workers'];
  if (Array.isArray(embeddedWorkers)) {
    lines.push(`Workers (embedded): ${embeddedWorkers.length}`);
  }

  if (data.workers !== undefined) {
    lines.push('');
    lines.push('WORKERS');
    if (data.workers.length === 0) {
      const empty = await renderTable(['ID', 'FULLNAME'], [['', '(no workers)']], {
        nameColumnIndex: 1,
      });
      lines.push(empty.trimEnd());
    } else {
      const rows = data.workers.map((w) => [String(w.id), w.fullname]);
      const table = await renderTable(['ID', 'FULLNAME'], rows, { nameColumnIndex: 1 });
      lines.push(table.trimEnd());
    }
  }

  return lines.join('\n');
}

function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  // ISO timestamp → date prefix only.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m?.[1] ?? value;
}

function formatState(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return '';
  const s = (value as { state?: unknown }).state;
  return typeof s === 'string' ? s : '';
}

function formatOwner(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return '';
  const f = (value as { fullname?: unknown }).fullname;
  return typeof f === 'string' ? f : '';
}

function formatCurrency(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return '';
  const c = value as { amount?: unknown; currency?: unknown };
  if (typeof c.amount !== 'string' || typeof c.currency !== 'string') return '';
  return `${c.amount} ${c.currency}`;
}

function formatSpent(realCost: unknown, minutesSpent: unknown): string {
  const cost = formatCurrency(realCost);
  if (cost === '' && (minutesSpent === null || minutesSpent === undefined)) return '';
  if (typeof minutesSpent === 'number') {
    return cost === '' ? `(${minutesSpent} min)` : `${cost} (${minutesSpent} min)`;
  }
  return cost;
}
