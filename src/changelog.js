// Keeps CHANGELOG.md: one entry per Figma version, newest first.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { groupTitle } from './describe.js';

const MARKER = '<!-- entries: newest first -->';
const HEADER = `# Design changelog\n\nWritten automatically by figma-changelog. Newest first.\n\n${MARKER}\n`;

const md = (s) => String(s).replace(/([\\`*_[\]|<>#])/g, '\\$1');

export function renderEntry(update) {
  const L = update.labels;
  const v = update.version;
  const out = [];
  out.push(`## ${v.time} · ${md(v.author)} · ${update.totalChanges} change${update.totalChanges === 1 ? '' : 's'}`);
  if (v.label || v.description) out.push('', `*${md([v.label, v.description].filter(Boolean).join(' — '))}*`);
  out.push('', `[${L.openInFigma}](${update.fileUrl}) · version \`${v.id}\``);

  for (const page of update.pages) {
    out.push('', `### ${md(page.name)}`, '');
    for (const g of page.groups) {
      out.push(`- ${groupTitle(g, (f) => `[**${md(f.name)}**](${f.url})`)}`);
      for (const l of g.lines) {
        const [first, ...rest] = l.split('\n');
        out.push(`  - ${md(first)}`, ...rest.map((r) => `    - ${md(r)}`));
      }
      if (g.hiddenLines) out.push(`  - …and ${g.hiddenLines} more`);
    }
  }

  const pictured = update.pairs.filter((p) => p.before?.file || p.after?.file);
  if (pictured.length) {
    out.push('', `### ${md(L.before)} / ${md(L.after)}`);
    for (const p of pictured) {
      const cell = (x, label) => (x?.file ? `![${md(p.frame.name)} – ${md(label)}](${x.file})` : '—');
      out.push('', `**${md(p.frame.name)}**${p.frame.tag ? ` (${md(p.frame.tag)})` : ''}`, '');
      out.push(`| ${md(L.before)} | ${md(L.after)} |`, '|---|---|');
      out.push(`| ${cell(p.before, L.before)} | ${cell(p.after, L.after)} |`);
    }
  }
  return out.join('\n') + '\n';
}

export function prependEntry(file, update) {
  let text = existsSync(file) ? readFileSync(file, 'utf8') : HEADER;
  if (!text.includes(MARKER)) text = HEADER + '\n' + text;
  const at = text.indexOf(MARKER) + MARKER.length;
  text = text.slice(0, at) + '\n\n' + renderEntry(update) + text.slice(at).replace(/^\n+/, '\n');
  writeFileSync(file, text);
}
