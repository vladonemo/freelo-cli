import { type FilesUploadData } from '../../api/schemas/file.js';

/**
 * Human renderer for `freelo files upload` (R25, spec 0037 §3.3).
 *
 * Live (all-success):
 *   Uploaded 2 files:
 *     report.pdf (a1b2c3d4-… , 12.3 KB)
 *     diagram.svg (e5f6g7h8-… , 4.5 KB)
 *
 * Live (with attach):
 *   Uploaded 2 files:
 *     ...
 *   Attached to task 4711 (comment 99812).
 *
 * Live (partial failure):
 *   Uploaded 1 file, 1 failed:
 *     report.pdf (a1b2c3d4-… , 12.3 KB)
 *   Failed:
 *     diagram.svg: SERVER_ERROR — Freelo API server error (HTTP 500).
 *
 * Dry-run:
 *   (dry-run) Would upload 2 files: report.pdf, diagram.svg.
 *   (dry-run) Would attach to task 4711.
 */
export function renderFilesUploadHuman(data: FilesUploadData): string {
  if (data.would !== undefined) {
    return renderDryRun(data);
  }
  return renderLive(data);
}

function renderDryRun(data: FilesUploadData): string {
  const lines: string[] = [];
  // Names come from the would.body.multipart.file basename — but we don't
  // need to dig into the would body; the requested count is what matters.
  // The would array carries the per-file POST descriptors which the
  // structured envelope already exposes. Keep human output small.
  const requested = data.count.requested;
  const noun = requested === 1 ? 'file' : 'files';
  lines.push(`(dry-run) Would upload ${requested} ${noun}.`);
  // If a comment-create entry is in `would`, mention attachment.
  const hasCommentWould = data.would?.some((w) => w.path.includes('/comments')) ?? false;
  if (hasCommentWould) {
    lines.push(`(dry-run) Would attach uploaded files to a task via a comment.`);
  }
  return lines.join('\n');
}

function renderLive(data: FilesUploadData): string {
  const lines: string[] = [];
  const { uploaded, failed, count, attached } = data;

  if (failed.length === 0) {
    const noun = count.uploaded === 1 ? 'file' : 'files';
    lines.push(`Uploaded ${count.uploaded} ${noun}:`);
  } else {
    const upNoun = count.uploaded === 1 ? 'file' : 'files';
    lines.push(`Uploaded ${count.uploaded} ${upNoun}, ${count.failed} failed:`);
  }
  for (const u of uploaded) {
    lines.push(`  ${u.filename} (${u.uuid}, ${formatBytes(u.bytes)})`);
  }

  if (failed.length > 0) {
    lines.push('Failed:');
    for (const f of failed) {
      lines.push(`  ${f.path}: ${f.error.code} — ${f.error.message}`);
    }
  }

  if (attached !== undefined) {
    lines.push(`Attached to task ${attached.task_id} (comment ${attached.comment_id}).`);
  }

  return lines.join('\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
