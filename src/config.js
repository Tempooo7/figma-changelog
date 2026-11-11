import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  projectName: '',
  watchedPagePrefixes: [],
  maxPicturesPerUpdate: 6,
  imageScale: 2,
  maxLinesPerFrame: 8,
  timezone: 'UTC',
  labels: {
    before: 'Before',
    after: 'After',
    new: 'New',
    deleted: 'Deleted',
    openInFigma: 'Open in Figma',
  },
  channels: {
    gchat: { enabled: true },
    slack: { enabled: true, threads: true },
    telegram: { enabled: true },
  },
};

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, 'utf8').trim();
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${e.message}`);
  }
}

export function writeJson(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

/** Minimal .env reader: KEY=value lines, # comments. Never overrides real env vars. */
export function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = value;
  }
}

export function loadConfig(root) {
  const user = readJson(path.join(root, 'config.json'), {});
  const cfg = {
    ...DEFAULTS,
    ...user,
    labels: { ...DEFAULTS.labels, ...(user.labels || {}) },
    channels: { ...DEFAULTS.channels },
  };
  for (const [name, c] of Object.entries(user.channels || {})) {
    cfg.channels[name] = { ...(DEFAULTS.channels[name] || {}), ...c };
  }
  if (!Array.isArray(cfg.watchedPagePrefixes)) throw new Error('config.json: watchedPagePrefixes must be a list, e.g. ["Mobile", "Web"]');
  cfg.maxPicturesPerUpdate = Math.max(0, Number(cfg.maxPicturesPerUpdate) || 0);
  cfg.imageScale = Math.min(4, Math.max(0.01, Number(cfg.imageScale) || 2));
  cfg.maxLinesPerFrame = Math.max(1, Number(cfg.maxLinesPerFrame) || 8);
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: cfg.timezone });
  } catch {
    throw new Error(`config.json: unknown timezone "${cfg.timezone}" (examples: "UTC", "Europe/London", "Africa/Cairo")`);
  }
  return cfg;
}

/** Page names compare loosely: emoji style codes, repeated spaces and letter case don't matter. */
export const normalizePageName = (s) =>
  String(s).normalize('NFKC').replace(/[︎️​-‍]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function pageMatches(pageName, prefixes) {
  if (!prefixes.length) return true;
  const name = normalizePageName(pageName);
  return prefixes.some((p) => name.startsWith(normalizePageName(p)));
}

/** Accepts a bare key or any figma.com file/design/branch link. */
export function parseFileKey(value) {
  // Forgiving: accepts "KEY", a figma.com link, quotes, stray spaces/new lines, or a pasted "FIGMA_FILE_KEY=" prefix.
  const v = String(value || '')
    .trim()
    .replace(/^FIGMA_FILE_KEY\s*=\s*/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
  if (!v) return '';
  const branch = v.match(/figma\.com\/(?:file|design)\/[A-Za-z0-9]+\/branch\/([A-Za-z0-9]+)/);
  if (branch) return branch[1];
  const m = v.match(/figma\.com\/(?:file|design|proto|board|make)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9]+$/.test(v)) return v;
  return v.match(/(?<![A-Za-z0-9])[A-Za-z0-9]{22}(?![A-Za-z0-9])/)?.[0] || '';
}

const SECRET_NAMES = ['FIGMA_TOKEN', 'FIGMA_FILE_KEY', 'GCHAT_WEBHOOK_URL', 'SLACK_BOT_TOKEN', 'SLACK_CHANNEL_ID',
  'SLACK_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_TOPIC_ID'];

/** Returns a copy of env with pasting mistakes removed: spaces/new lines, quotes, a "NAME=" prefix. */
export function cleanSecrets(env) {
  const out = { ...env };
  for (const name of SECRET_NAMES) {
    if (typeof out[name] !== 'string') continue;
    out[name] = out[name]
      .trim()
      .replace(new RegExp(`^${name}\\s*=\\s*`, 'i'), '')
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
      .trim();
  }
  return out;
}

/** Describes what a secret looks like without revealing it (for error messages). */
export function describeSecretShape(value) {
  const v = String(value ?? '');
  if (!v) return 'it is empty';
  const notes = [`${v.length} characters`];
  if (/^\s|\s$/.test(v)) notes.push('has spaces or a new line at the start/end');
  if (/["'“”‘’]/.test(v)) notes.push('contains quote marks');
  if (/=/.test(v)) notes.push('contains "="');
  if (/^https?:/i.test(v.trim())) notes.push('is a link');
  return notes.join(', ');
}
