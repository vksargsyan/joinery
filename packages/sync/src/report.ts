import { summarizeDiff } from './compare';
import type { SchemaDiff, SyncOperation } from './model';
import type { GeneratedScript } from './script';

/** HTML report labels and extras. */
export interface HtmlReportOptions {
  readonly title?: string;
  /** Labels for the two sides, e.g. connection names; default engine + database. */
  readonly sourceLabel?: string;
  readonly targetLabel?: string;
  /** Include this deployment script at the end. */
  readonly script?: GeneratedScript;
  /** Shown under the title, e.g. the compare time; left out by default so reports are reproducible. */
  readonly generatedAt?: string;
}

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root{--bg:#fff;--fg:#1c1e21;--muted:#61656b;--line:#dcdfe3;--panel:#f5f6f8;--add:#e6f4ea;--drop:#fce8e6;--alter:#fef7e0;--warn:#b26a00}
@media (prefers-color-scheme:dark){:root{--bg:#16181c;--fg:#e4e6ea;--muted:#9aa0a8;--line:#30343b;--panel:#1f2227;--add:#16301f;--drop:#3a1d1b;--alter:#332b12;--warn:#f0b35a}}
*{box-sizing:border-box}body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)}.cards{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:8px 12px;min-width:110px}
.card b{display:block;font-size:20px}ul.warnings{padding-left:18px;color:var(--warn)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr.create td:first-child{background:var(--add)}tr.drop td:first-child{background:var(--drop)}tr.alter td:first-child,tr.rename td:first-child{background:var(--alter)}
.tag{display:inline-block;font-size:11px;padding:0 6px;border-radius:9px;border:1px solid var(--line);margin-left:4px}
details{border:1px solid var(--line);border-radius:6px;margin:8px 0;background:var(--panel)}summary{cursor:pointer;padding:6px 10px}
.sides{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:0 10px 10px}@media (max-width:720px){.sides{grid-template-columns:1fr}}
pre{margin:0;padding:8px;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:4px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
.sides h4{margin:6px 0;font-size:12px;color:var(--muted)}
`;

function operationRow(op: SyncOperation): string {
  const tags = [
    op.destructive ? '<span class="tag">destructive</span>' : '',
    op.selected ? '' : '<span class="tag">not selected</span>',
  ].join('');
  const warnings = op.warnings
    .map((w) => `<div class="muted">${escapeHtml(w.message)}</div>`)
    .join('');
  const changes =
    op.changes.length > 0 ? `<div>${op.changes.map(escapeHtml).join('<br>')}</div>` : '';
  return `<tr class="${escapeHtml(op.kind)}"><td>${escapeHtml(op.kind)}</td><td>${escapeHtml(op.objectKind)}</td><td><code>${escapeHtml(op.qualifiedName)}</code>${tags}</td><td>${changes}${warnings}</td></tr>`;
}

function operationDetails(op: SyncOperation, sourceLabel: string, targetLabel: string): string {
  const side = (label: string, ddl: string | undefined): string =>
    `<div><h4>${escapeHtml(label)}</h4><pre>${ddl === undefined ? '<span class="muted">(absent)</span>' : escapeHtml(ddl)}</pre></div>`;
  const statements =
    op.statements.length > 0
      ? `<div class="sides" style="grid-template-columns:1fr"><div><h4>Statements</h4><pre>${escapeHtml(op.statements.map((s) => `${s};`).join('\n'))}</pre></div></div>`
      : '';
  return `<details><summary>${escapeHtml(op.kind)} ${escapeHtml(op.objectKind)} <code>${escapeHtml(op.qualifiedName)}</code></summary><div class="sides">${side(sourceLabel, op.sourceDdl)}${side(targetLabel, op.targetDdl)}</div>${statements}</details>`;
}

/**
 * A self-contained HTML report of a comparison (spec §13: "export an HTML report"): summary
 * counts, warnings, the operation list, side-by-side DDL for each operation and, optionally,
 * the script. No scripts or external resources; every value is escaped.
 */
export function renderHtmlReport(diff: SchemaDiff, options: HtmlReportOptions = {}): string {
  const summary = summarizeDiff(diff);
  const sourceLabel = options.sourceLabel ?? `Source: ${diff.sourceEngine} ${diff.sourceDatabase}`;
  const targetLabel = options.targetLabel ?? `Target: ${diff.targetEngine} ${diff.targetDatabase}`;
  const title = options.title ?? 'Structure comparison';
  const cards = [
    ['Operations', summary.total],
    ['Create', summary.create],
    ['Alter', summary.alter],
    ['Drop', summary.drop],
    ['Rename', summary.rename],
    ['Destructive', summary.destructive],
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><span class="muted">${escapeHtml(String(label))}</span><b>${escapeHtml(String(value))}</b></div>`,
    )
    .join('');
  const warnings =
    diff.warnings.length > 0
      ? `<ul class="warnings">${diff.warnings.map((w) => `<li>${escapeHtml(w.message)}</li>`).join('')}</ul>`
      : '';
  const body = diff.identical
    ? '<p>The databases are identical.</p>'
    : `<h2>Operations</h2><table><thead><tr><th>Action</th><th>Object</th><th>Name</th><th>Changes</th></tr></thead><tbody>${diff.operations.map(operationRow).join('')}</tbody></table>
<h2>Side by side</h2>${diff.operations.map((op) => operationDetails(op, sourceLabel, targetLabel)).join('\n')}`;
  const script =
    options.script !== undefined
      ? `<h2>Script</h2><pre>${escapeHtml(options.script.text)}</pre>`
      : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1>
<div class="muted">${escapeHtml(sourceLabel)} → ${escapeHtml(targetLabel)}${options.generatedAt !== undefined ? ` · ${escapeHtml(options.generatedAt)}` : ''}</div>
<div class="cards">${cards}</div>${warnings}${body}${script}
</main></body></html>
`;
}
