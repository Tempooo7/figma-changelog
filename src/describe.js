// Turns diff changes into short, plain-language lines. A line may contain "\n": the extra lines
// are details (e.g. Before/After of a text change) that channels show indented underneath.

const FSI = '⁨'; // first-strong isolate: keeps Arabic/English runs in the right order where supported
const PDI = '⁩';
const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/;

/** Isolate a run of text so mixed RTL/LTR content doesn't reorder the surrounding line. */
export const bidi = (s) => `${FSI}${s}${PDI}`;

/** Quoted, isolated, shortened text value. */
export const quote = (s, max = 160) => `«${bidi(clip(String(s).replace(/\s*\n\s*/g, ' ⏎ '), max))}»`;

export function clip(s, max) {
  const chars = [...String(s)];
  return chars.length > max ? chars.slice(0, max - 1).join('') + '…' : chars.join('');
}

function listNames(names, max = 3) {
  const shown = names.slice(0, max).map(bidi).join(', ');
  return names.length > max ? `${shown} +${names.length - max} more` : shown;
}

const LAYOUT = { horizontal: 'side by side', vertical: 'stacked', grid: 'grid', none: 'no auto layout' };

/** "old → new" on one line for short left-to-right values; Before/After lines otherwise (Arabic safe). */
function beforeAfter(title, oldV, newV, labels, max) {
  const o = String(oldV);
  const n = String(newV);
  if (!RTL.test(o + n) && o.length + n.length <= 60) return `${title} ${quote(o, max)} → ${quote(n, max)}`;
  return `${title}\n${labels.before}: ${quote(o, max)}\n${labels.after}: ${quote(n, max)}`;
}

function paintLine(word, c) {
  if (c.old === 'none') return `${word} added: ${c.new}`;
  if (c.new === 'none') return `${word} removed (was ${c.old})`;
  return `${word} ${c.old} → ${c.new}`;
}

function what(c, labels) {
  switch (c.kind) {
    case 'text': return beforeAfter('text changed', c.old, c.new, labels);
    case 'fill': return paintLine('colour', c);
    case 'stroke': return paintLine('border', c);
    case 'size': return `size ${c.old} → ${c.new}`;
    case 'gap': return `spacing between items ${c.old} → ${c.new}`;
    case 'padding':
      if (c.sides?.length && c.sides.length < 4) return c.sides.map(([side, o, n]) => `${side} padding ${o} → ${n}`).join(', ');
      return `padding ${c.old} → ${c.new}`;
    case 'radius': return `corner radius ${c.old} → ${c.new}`;
    case 'layout': return `layout ${LAYOUT[c.old] || c.old} → ${LAYOUT[c.new] || c.new}`;
    case 'swap': return `component swapped: ${bidi(c.old)} → ${bidi(c.new)}`;
    case 'variant': return `${bidi(c.prop)}: ${bidi(c.old)} → ${bidi(c.new)}`;
    case 'visibility': return c.new ? 'now shown' : 'now hidden';
    case 'reparent': return `moved here from ${bidi(c.old)}`;
    case 'frame-renamed': return beforeAfter('frame renamed', c.old, c.new, labels, 80);
    case 'frame-page': return `moved from page ${quote(c.old, 80)}`;
    case 'frame-moved': return 'moved on the canvas';
    case 'layers-added': return `Added: ${listNames(c.names)}`;
    case 'layers-removed': return `Removed: ${listNames(c.names)}`;
    default: return c.kind;
  }
}

// Structure first, then words, then looks.
const ORDER = ['frame-renamed', 'frame-page', 'layers-added', 'layers-removed', 'reparent', 'text', 'swap', 'variant',
  'visibility', 'fill', 'stroke', 'layout', 'size', 'gap', 'padding', 'radius', 'frame-moved'];
const rank = (k) => (ORDER.indexOf(k) + 1) || 99;

/**
 * All lines for one frame, most important first. Identical changes on several layers are merged
 * ("Button, Card +3 more: colour #111111 → brand/600").
 */
export function describeFrame(frame, labels) {
  // Several 1–4 letter text edits (initials, badges, counters) become one line; the pictures show them.
  const isShort = (c) => c.kind === 'text' && [...String(c.old).trim()].length <= 4 && [...String(c.new).trim()].length <= 4;
  const short = frame.changes.filter(isShort);
  const changes = short.length >= 2 ? frame.changes.filter((c) => !isShort(c)) : frame.changes;
  const extra = short.length >= 2 ? [`${short.length} short texts changed (1–4 letters each, see the pictures)`] : [];

  const groups = new Map();
  for (const c of changes) {
    const key = JSON.stringify([c.kind, c.old, c.new, c.prop, c.count, c.names]);
    if (!groups.has(key)) groups.set(key, { change: c, nodes: [] });
    if (c.node && !groups.get(key).nodes.includes(c.node)) groups.get(key).nodes.push(c.node);
  }
  const lines = [...groups.values()]
    .sort((a, b) => rank(a.change.kind) - rank(b.change.kind))
    .map(({ change, nodes }) => {
      const text = what(change, labels);
      if (!nodes.length) return text[0].toUpperCase() + text.slice(1);
      return `${listNames(nodes, 2)}: ${text}`;
    });
  return [...lines, ...extra];
}

/** Number of changes counted for the header. */
export function countChanges(frame) {
  if (frame.status !== 'changed') return 1;
  return frame.changes.reduce((n, c) => n + (c.count || 1), 0);
}

/**
 * The summary as a flat list every channel can render:
 *   { kind: 'page', name }
 *   { kind: 'group', frames: [{name, url, tag}], lines: string[], hiddenLines }
 * A group with several frames means "the same changes were made in all of these frames".
 */
export function summaryItems(update) {
  const items = [];
  for (const page of update.pages) {
    items.push({ kind: 'page', name: page.name });
    for (const g of page.groups) items.push({ kind: 'group', ...g });
  }
  return items;
}

/** Header of a group: "Home (New)" or "Same change in 4 frames: A, B, C, D". */
export function groupTitle(g, fmt = (f) => f.name) {
  const names = g.frames.map((f) => fmt(f) + (f.tag ? ` (${f.tag})` : ''));
  return g.frames.length > 1 ? `Same change in ${g.frames.length} frames: ${names.join(', ')}` : names[0];
}

/** Plain-text rendering, used in logs and dry runs. */
export function renderPlain(update) {
  const out = [update.title];
  const note = [update.version.label, update.version.description].filter(Boolean).join(' — ');
  if (note) out.push(`  “${note}”`);
  for (const item of summaryItems(update)) {
    if (item.kind === 'page') {
      out.push('', `  ${item.name}`);
      continue;
    }
    out.push(`   • ${groupTitle(item)}`);
    for (const l of item.lines) {
      const [first, ...rest] = l.split('\n');
      out.push(`       – ${first}`, ...rest.map((r) => `           ${r}`));
    }
    if (item.hiddenLines) out.push(`       – …and ${item.hiddenLines} more`);
  }
  return out.join('\n');
}
