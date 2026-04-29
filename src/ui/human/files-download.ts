import { type FilesDownloadData } from '../../api/schemas/file.js';
import { humanizeBytes } from '../../lib/format.js';

/**
 * Human renderer for `freelo files download` (R27, spec 0039 §3.5).
 *
 * One-line summary printed to stdout in `human` mode:
 *
 *   Downloaded report.pdf (2.4 MB) → /home/user/report.pdf
 *
 * When `Content-Disposition` is absent (so `filename` is null), the inline
 * filename is omitted:
 *
 *   Downloaded 2.4 MB → /home/user/aaa-…-001.bin
 *
 * The `--stdout` path never invokes this renderer (per the matrix in spec
 * 0039 §3.4 — `human` + `--stdout` is silent on stderr).
 */
export function renderFilesDownloadHuman(data: FilesDownloadData): string {
  const sizeText = humanizeBytes(data.bytes);
  const namePart = data.filename !== null ? `${data.filename} (${sizeText})` : sizeText;
  return `Downloaded ${namePart} → ${data.destination}`;
}
