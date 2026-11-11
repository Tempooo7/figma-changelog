// Builds the one neutral "Update" that every channel turns into its own message format.
import { describeFrame, countChanges, bidi } from './describe.js';
import { figmaFileUrl } from './figma.js';

export function formatTime(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

const RANK = { added: 0, changed: 1, deleted: 2 };

/**
 * Per page: changes made identically in several frames are shown once, under all those frames;
 * each frame then lists only what is unique to it.
 */
function groupPage(frames, maxLines) {
  const ref = (f) => ({ id: f.id, name: f.name, url: f.url, tag: f.tag });
  const cap = (lines) => ({ lines: lines.slice(0, maxLines), hiddenLines: Math.max(0, lines.length - maxLines) });

  const where = new Map(); // line → frames that have it
  for (const f of frames) for (const l of f.allLines) where.set(l, [...(where.get(l) || []), f]);

  const shared = new Map(); // "id,id,…" → { frames, lines }
  for (const [line, fs] of where) {
    if (fs.length < 2) continue;
    const key = fs.map((f) => f.id).join(',');
    if (!shared.has(key)) shared.set(key, { frames: fs.map(ref), lines: [] });
    shared.get(key).lines.push(line);
  }

  const groups = [...shared.values()]
    .sort((a, b) => b.frames.length - a.frames.length || b.lines.length - a.lines.length)
    .map((g) => ({ frames: g.frames, ...cap(g.lines) }));
  for (const f of frames) {
    const own = f.allLines.filter((l) => where.get(l).length < 2);
    if (own.length || f.status !== 'changed') groups.push({ frames: [ref(f)], ...cap(own) });
  }
  return groups;
}

export function buildUpdate({ cfg, fileKey, fileName, version, prevVersionId, diff }) {
  const labels = cfg.labels;
  const frames = diff.frames.map((f, order) => ({
    id: f.id,
    name: f.name,
    page: f.page,
    status: f.status,
    tag: f.status === 'added' ? labels.new : f.status === 'deleted' ? labels.deleted : '',
    url: figmaFileUrl(fileKey, f.status === 'deleted' ? null : f.id),
    allLines: describeFrame(f, labels),
    score: countChanges(f),
    order,
  }));

  const pages = [];
  for (const f of frames) {
    let p = pages.find((x) => x.name === f.page);
    if (!p) pages.push((p = { name: f.page, frames: [] }));
    p.frames.push(f);
  }
  for (const p of pages) p.groups = groupPage(p.frames, cfg.maxLinesPerFrame);

  // Most important first: added frames, then frames with the most changes, then deleted ones.
  const ranked = [...frames].sort((a, b) => RANK[a.status] - RANK[b.status] || b.score - a.score || a.order - b.order);

  const total = frames.reduce((n, f) => n + f.score, 0);
  const project = cfg.projectName || fileName || 'Figma file';
  const author = version.user?.handle || 'Someone';
  const time = formatTime(version.created_at, cfg.timezone);

  return {
    project,
    fileKey,
    fileUrl: figmaFileUrl(fileKey),
    title: `${bidi(project)}: ${total} change${total === 1 ? '' : 's'} · ${bidi(author)} · ${time}`,
    totalChanges: total,
    version: {
      id: version.id,
      label: version.label || '',
      description: version.description || '',
      author,
      createdAt: version.created_at,
      time,
    },
    prevVersionId,
    pages,
    frames: ranked,
    pairs: [], // filled by attachPictures()
    labels,
  };
}
