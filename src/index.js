#!/usr/bin/env node
// figma-changelog: posts Figma version changes to Google Chat, Slack and/or Telegram.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, loadConfig, loadDotEnv, parseFileKey, describeSecretShape, cleanSecrets, pageMatches, readJson, writeJson } from './config.js';
import { FigmaClient } from './figma.js';
import { requestJson } from './http.js';
import { compare } from './diff.js';
import { buildUpdate, formatTime } from './update.js';
import { renderPlain } from './describe.js';
import { attachPictures } from './images.js';
import { prependEntry } from './changelog.js';
import { loadState, saveState } from './state.js';
import gchat from './channels/gchat.js';
import slack from './channels/slack.js';
import telegram from './channels/telegram.js';

export const CHANNELS = [gchat, slack, telegram];

const HELP = `
Usage:
  node src/index.js                 normal run (used by GitHub Actions)
  node src/index.js --dry-run       show what would be posted; posts and saves nothing
  node src/index.js --dry-run --versions OLD,NEW   compare two specific version IDs
  node src/index.js --dry-run --last 3             compare each of the 3 newest versions with the one before it
  node src/index.js --send-test     post the newest version once, marked TEST, to every channel with secrets
  node src/index.js --send-test --only slack       …to one channel only (gchat, slack, telegram)
  node src/index.js --telegram-chat-id             list the Telegram groups your bot is in, with their IDs

Settings: config.json. Secrets: .env locally, GitHub Secrets in Actions.
`;

function parseArgs(argv) {
  const a = { dryRun: false, sendTest: false, only: null, telegramChatId: false, versions: null, last: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--dry-run') a.dryRun = true;
    else if (k === '--help' || k === '-h') a.help = true;
    else if (k === '--send-test') a.sendTest = true;
    else if (k === '--only') a.only = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--telegram-chat-id') a.telegramChatId = true;
    else if (k === '--versions') a.versions = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (k === '--last') a.last = Math.max(1, Number(argv[++i]) || 1);
    else throw new Error(`Unknown option ${k}. Try --help`);
  }
  if (a.versions && a.versions.length !== 2) throw new Error('--versions needs two IDs: OLD,NEW');
  if (a.dryRun && a.sendTest) throw new Error('Use either --dry-run or --send-test, not both');
  return a;
}

export async function main(argv = process.argv.slice(2), opts = {}) {
  const root = opts.root || ROOT;
  const log = opts.log || console.log;
  const args = parseArgs(argv);
  if (args.help) {
    log(HELP);
    return 0;
  }

  loadDotEnv(path.join(root, '.env'));
  const rawEnv = opts.env || process.env;
  const env = cleanSecrets(rawEnv);
  const cfg = loadConfig(root);
  if (args.telegramChatId) return telegramChatIds(env, log);
  const fileKey = parseFileKey(env.FIGMA_FILE_KEY);
  const missing = [!env.FIGMA_TOKEN && 'FIGMA_TOKEN', !fileKey && 'FIGMA_FILE_KEY'].filter(Boolean);
  if (missing.length) {
    log(`Missing ${missing.join(' and ')}. Put it in .env (local) or GitHub Secrets (Actions). See .env.example.`);
    if (missing.includes('FIGMA_FILE_KEY') && env.FIGMA_FILE_KEY) {
      log(`FIGMA_FILE_KEY is set but no file key was found in it (${describeSecretShape(env.FIGMA_FILE_KEY)}). ` +
        'It should be the part after /design/ in the file link, e.g. AbCdEfGhIjKlMnOpQrStUv, or the whole link.');
    }
    return 2;
  }

  const figma = new FigmaClient({ token: env.FIGMA_TOKEN, fileKey, log });
  const variables = readJson(path.join(root, 'variables-map.json'), {});
  const prefixes = cfg.watchedPagePrefixes.map((p) => String(p).trim()).filter(Boolean);
  const enabled = CHANNELS.filter((c) => cfg.channels[c.name]?.enabled !== false);
  let active = enabled.filter((c) => c.isConfigured(env));
  if (args.only) {
    const unknown = args.only.filter((n) => !CHANNELS.some((c) => c.name === n));
    if (unknown.length) throw new Error(`--only: unknown channel ${unknown.join(', ')} (use gchat, slack, telegram)`);
    active = active.filter((c) => args.only.includes(c.name));
  }

  log(`figma-changelog${args.dryRun ? ' — DRY RUN (nothing is posted or saved)' : args.sendTest ? ' — TEST POST (posts once, saves no state)' : ''}`);
  log(`Watching pages: ${prefixes.length ? prefixes.map((p) => `“${p}…”`).join(', ') : 'all pages'}`);
  for (const c of CHANNELS) {
    const state = cfg.channels[c.name]?.enabled === false ? 'off (disabled in config.json)' : c.isConfigured(env) ? 'on' : 'off (no secrets)';
    log(`Channel ${c.title}: ${state}${args.dryRun && state !== 'on' && enabled.includes(c) ? ' — previewed anyway' : ''}`);
  }

  // ---------- snapshots (cached: version N's "after" is version N+1's "before") ----------
  const cache = new Map();
  let warnedPages = false;
  const snapshot = async (versionId) => {
    if (cache.has(versionId)) return cache.get(versionId);
    const { fileName, pages } = await figma.getPages(versionId);
    const watched = pages.filter((p) => pageMatches(p.name, prefixes));
    if (!watched.length && !warnedPages) {
      warnedPages = true;
      log(`⚠ No page matches watchedPagePrefixes. Pages in this file: ${pages.map((p) => `“${p.name}”`).join(', ')}`);
    }
    const snap = await figma.getPageTrees(versionId, watched.map((p) => p.id));
    snap.fileName = fileName;
    cache.set(versionId, snap);
    if (cache.size > 3) cache.delete(cache.keys().next().value);
    return snap;
  };

  const updateFor = async (prev, v) => {
    const before = await snapshot(prev.id);
    const after = await snapshot(v.id);
    const diff = compare(before, after, { variables });
    if (!diff.frames.length) return null;
    return buildUpdate({ cfg, fileKey, fileName: after.fileName, version: v, prevVersionId: prev.id, diff });
  };

  const describeVersion = (v) =>
    `${v.id} · ${formatTime(v.created_at, cfg.timezone)} · ${v.user?.handle || '?'}${v.label ? ` · “${v.label}”` : ''}`;

  const finish = (code) => {
    log(`Figma API calls: ${figma.calls}${figma.throttled ? ` · throttled ${figma.throttled}× — see messages above` : ' · no throttling'}`);
    return code;
  };

  // ---------- dry run / test post ----------
  if (args.sendTest && !active.length) {
    log(args.only ? `No secrets for ${args.only.join(', ')} in .env yet.` : 'No channel has secrets in .env yet, nothing to send.');
    return finish(2);
  }
  if (args.dryRun || args.sendTest) {
    const state = loadState(root);
    let comparisons = [];
    if (args.versions) {
      const versions = await figma.getVersions(new Set(args.versions));
      const find = (id) => versions.find((v) => v.id === id) || { id, created_at: new Date().toISOString(), user: {} };
      comparisons = [[find(args.versions[0]), find(args.versions[1])]];
    } else {
      const versions = await figma.getVersions(new Set(state?.lastProcessed ? [state.lastProcessed] : []), state ? 20 : 1);
      if (versions.length < 2) {
        log('This file has fewer than 2 versions, nothing to compare yet.');
        return finish(0);
      }
      const stopAt = state?.lastProcessed ? versions.findIndex((v) => v.id === state.lastProcessed) : -1;
      const pool = stopAt > 0 ? versions.slice(0, Math.min(stopAt, 10)) : versions.slice(0, args.last);
      comparisons = pool.reverse().map((v) => [versions[versions.indexOf(v) + 1], v]).filter(([p]) => p);
      if (stopAt > 0) log(`Comparing versions newer than the saved state (${stopAt} new).`);
      else if (stopAt === 0) log('No versions newer than the saved state; showing the latest version instead.');
    }

    for (const [prev, v] of comparisons) {
      log(`\n━━ Version ${describeVersion(v)}  (compared with ${prev.id})`);
      const update = await updateFor(prev, v);
      if (!update) {
        log('No meaningful changes in the watched pages — nothing would be posted.');
        continue;
      }
      const dir = `.dry-run/${v.id}`;
      await attachPictures(update, figma, { root, relDir: dir, max: cfg.maxPicturesPerUpdate, scale: cfg.imageScale, log });
      log('\n' + renderPlain(update));
      log(`\nPictures: ${update.pairs.length} frame(s) → ${dir}/`);
      if (args.sendTest) {
        update.title = `🧪 TEST · ${update.title}`;
        const testRunId = Date.now().toString(36);
        let bad = 0;
        for (const c of active) {
          try {
            const n = await c.send(update, { env, cfg, log, testRunId });
            log(`✓ ${c.title}: sent ${n} message(s). Check how it looks.`);
          } catch (e) {
            bad++;
            log(`✗ ${c.title}: ${e.message}`);
          }
        }
        return finish(bad ? 1 : 0);
      }
      for (const c of enabled) {
        const preview = c.preview(update, { env, cfg });
        writeJson(path.join(root, dir, `${c.name}.json`), preview);
        log(`\n--- ${c.title}: ${preview.length} message(s) (also saved to ${dir}/${c.name}.json) ---`);
        log(JSON.stringify(preview, null, 2));
      }
    }
    return finish(0);
  }

  // ---------- normal run ----------
  let state = loadState(root);
  if (!state) {
    const versions = await figma.getVersions(new Set(), 1);
    if (!versions.length) {
      log('This file has no versions yet. Nothing to do.');
      return finish(0);
    }
    const base = versions[0].id;
    saveState(root, { lastProcessed: base, channels: Object.fromEntries(active.map((c) => [c.name, base])) });
    log(`First run: saved version ${describeVersion(versions[0])} as the starting point. Nothing posted.`);
    return finish(0);
  }
  state.channels ||= {};

  const cursors = new Set([state.lastProcessed, ...active.map((c) => state.channels[c.name])].filter(Boolean));
  const versions = await figma.getVersions(cursors);
  if (!versions.length) return finish(0);
  const idx = new Map(versions.map((v, i) => [v.id, i]));
  const latest = versions[0];

  if (!idx.has(state.lastProcessed)) {
    log(`⚠ Saved version ${state.lastProcessed} not found in history; restarting from the latest version.`);
    state.lastProcessed = latest.id;
  }
  for (const c of active) {
    if (!state.channels[c.name]) {
      state.channels[c.name] = latest.id;
      log(`${c.title} is new: it starts from the current version (no old history is sent).`);
    } else if (!idx.has(state.channels[c.name])) {
      log(`⚠ ${c.title}: saved version not found in history; restarting from the latest version.`);
      state.channels[c.name] = latest.id;
    }
  }

  const oldest = Math.max(idx.get(state.lastProcessed), ...active.map((c) => idx.get(state.channels[c.name])));
  let chrono = versions.slice(0, oldest + 1).reverse(); // [cursor, …, newest]
  const maxPerRun = Number(cfg.maxVersionsPerRun) || 20;
  if (chrono.length - 1 > maxPerRun) {
    log(`${chrono.length - 1} new versions; handling the oldest ${maxPerRun} now, the rest next run.`);
    chrono = chrono.slice(0, maxPerRun + 1);
  }
  if (chrono.length < 2) {
    log('Nothing new since the last run.');
    saveState(root, state);
    return finish(0);
  }

  const failed = new Map();
  const isOlder = (cursorId, v) => idx.get(cursorId) > idx.get(v.id);
  for (let i = 1; i < chrono.length; i++) {
    const prev = chrono[i - 1];
    const v = chrono[i];
    const needLog = isOlder(state.lastProcessed, v);
    const targets = active.filter((c) => !failed.has(c.name) && isOlder(state.channels[c.name], v));
    if (!needLog && !targets.length) continue;

    log(`\n━━ Version ${describeVersion(v)}`);
    const update = await updateFor(prev, v);
    if (!update) {
      log('   no meaningful changes in the watched pages — nothing posted');
      for (const c of targets) state.channels[c.name] = v.id;
      if (needLog) state.lastProcessed = v.id;
      saveState(root, state);
      continue;
    }
    log(`   ${update.totalChanges} change(s) in ${update.frames.length} frame(s)`);
    const relDir = `changelog-images/${String(v.created_at).slice(0, 10)}-${v.id}`;
    await attachPictures(update, figma, { root, relDir, max: cfg.maxPicturesPerUpdate, scale: cfg.imageScale, log });
    log(`   pictures for ${update.pairs.length} frame(s)`);

    if (needLog) {
      prependEntry(path.join(root, 'CHANGELOG.md'), update);
      state.lastProcessed = v.id;
      log('   ✓ CHANGELOG.md updated');
    }
    for (const c of targets) {
      try {
        const n = await c.send(update, { env, cfg, log });
        state.channels[c.name] = v.id;
        log(`   ✓ ${c.title}: posted ${n} message(s)`);
      } catch (e) {
        failed.set(c.name, e.message);
        log(`   ✗ ${c.title} failed: ${e.message}`);
        log(`     ${c.title} will retry from this version on the next run; other channels continue.`);
      }
    }
    saveState(root, state);
  }

  saveState(root, state);
  if (failed.size) {
    log(`\nDone with errors: ${[...failed.keys()].join(', ')} failed (see above).`);
    return finish(1);
  }
  log('\nDone.');
  return finish(0);
}

/** Lists the chats the Telegram bot has seen, so you can copy the right TELEGRAM_CHAT_ID. */
async function telegramChatIds(env, log) {
  if (!env.TELEGRAM_BOT_TOKEN) {
    log('Put TELEGRAM_BOT_TOKEN in .env first.');
    return 2;
  }
  const data = await requestJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates`, {}, { label: 'Telegram getUpdates', log });
  const chats = new Map();
  for (const u of data.result || []) {
    const chat = (u.message || u.edited_message || u.channel_post || u.my_chat_member)?.chat;
    if (chat && chat.type !== 'private') chats.set(chat.id, chat);
  }
  if (!chats.size) {
    log('No groups found yet. Add the bot to your group, send any message in the group (for example "hi"), then run this again.');
    return 1;
  }
  log('Groups your bot is in:');
  for (const c of chats.values()) {
    log(`  ${c.title} (${c.type}${c.is_forum ? ', has topics' : ''})  →  TELEGRAM_CHAT_ID=${c.id}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`Error: ${e.message}`);
      if (/Figma .*HTTP (401|403)/.test(e.message)) {
        const t = cleanSecrets(process.env).FIGMA_TOKEN;
        console.error(
          `Figma rejected FIGMA_TOKEN (${describeSecretShape(process.env.FIGMA_TOKEN)}; after cleanup ${t?.length || 0} characters, ` +
            `${t?.startsWith('figd_') ? 'starts like a Figma token' : 'does NOT start with "figd_" like Figma tokens do'}). ` +
            'Re-paste the token into the secret, or create a new one if it expired or was revoked.',
        );
      }
      process.exitCode = 1;
    },
  );
}
