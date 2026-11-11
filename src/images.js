// Picks the frames that get pictures and fetches before/after PNGs from Figma.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const slug = (id) => id.replace(/[^A-Za-z0-9]+/g, '-');

/**
 * Fills update.pairs: [{ frame, before: {url, file, abs}|null, after: {...}|null }].
 * @param {object} o
 * @param {string} o.root    repo root (absolute)
 * @param {string} o.relDir  folder for PNGs, relative to root (e.g. changelog-images/2026-11-10-123)
 * @param {number} o.max     max frames with pictures
 */
export async function attachPictures(update, figma, { root, relDir, max, scale = 2, log = () => {} }) {
  const picked = update.frames.slice(0, max);
  const afterIds = picked.filter((f) => f.status !== 'deleted').map((f) => f.id);
  const beforeIds = picked.filter((f) => f.status !== 'added').map((f) => f.id);

  const after = afterIds.length ? await figma.getImageUrls(afterIds, update.version.id, scale) : {};
  const before = beforeIds.length ? await figma.getImageUrls(beforeIds, update.prevVersionId, scale) : {};

  const absDir = path.join(root, relDir);
  const save = async (frame, url, which) => {
    if (!url) return null;
    const file = `${relDir}/${slug(frame.id)}-${which}.png`;
    const abs = path.join(root, file);
    if (!existsSync(abs)) {
      try {
        mkdirSync(absDir, { recursive: true });
        writeFileSync(abs, await figma.download(url));
      } catch (e) {
        log(`  could not download ${which} picture of “${frame.name}”: ${e.message}`);
        return { url, file: null, abs: null };
      }
    }
    return { url, file, abs };
  };

  update.pairs = [];
  for (const frame of picked) {
    const pair = {
      frame,
      before: frame.status === 'added' ? null : await save(frame, before[frame.id], 'before'),
      after: frame.status === 'deleted' ? null : await save(frame, after[frame.id], 'after'),
    };
    if (pair.before || pair.after) update.pairs.push(pair);
  }
  update.unpictured = update.frames.length - update.pairs.length;
  return update;
}
