// Shared helpers for channel senders.

export const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Label under/over a picture: Before / After / New / Deleted. */
export function pictureLabel(pair, which, labels) {
  if (which === 'after' && !pair.before) return pair.frame.status === 'added' ? labels.new : labels.after;
  if (which === 'before' && !pair.after) return pair.frame.status === 'deleted' ? labels.deleted : labels.before;
  return which === 'before' ? labels.before : labels.after;
}

/** "+2 more frames in the thread · 3 more frames without pictures" */
export function moreText(update, inThread = true) {
  const parts = [];
  const rest = Math.max(0, update.pairs.length - 1);
  if (rest) parts.push(`+${rest} more frame${rest === 1 ? '' : 's'}${inThread ? ' in the thread' : ''}`);
  if (update.unpictured) parts.push(`${update.unpictured} more without pictures`);
  return parts.join(' · ');
}

/** Cut a list of lines so the joined text stays under `max` characters. */
export function fitLines(lines, max, sep = '\n') {
  const out = [];
  let len = 0;
  for (const l of lines) {
    if (len + l.length + sep.length > max - 40) {
      out.push('…more in CHANGELOG.md');
      break;
    }
    out.push(l);
    len += l.length + sep.length;
  }
  return out;
}

