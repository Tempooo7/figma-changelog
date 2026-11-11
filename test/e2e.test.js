// Runs the whole tool against fake Figma / Chat / Slack / Telegram servers.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '../src/index.js';
import { setSleep } from '../src/http.js';
import { snapshotV1, snapshotV2 } from './fixtures.js';

setSleep(() => Promise.resolve());

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const VERSIONS = [
  // newest first, like the Figma API
  { id: '300', created_at: '2026-11-10T09:30:00Z', label: 'Checkout v2', description: 'reviewed', user: { handle: 'Alex' } },
  { id: '200', created_at: '2026-11-10T08:30:00Z', label: '', description: '', user: { handle: 'Sam' } },
  { id: '100', created_at: '2026-11-10T07:30:00Z', label: '', description: '', user: { handle: 'Sam' } },
];
// 100 → 200: no change. 200 → 300: the V2 edits.
const SNAP = { 100: snapshotV1(), 200: snapshotV1(), 300: snapshotV2() };

let root;
let calls;
let failSlack;
const realFetch = globalThis.fetch;

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeFetch(input, init = {}) {
  const url = new URL(String(input));
  const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
  calls.push({ url, body });
  const v = url.searchParams.get('version');

  if (url.host === 'api.figma.com') {
    assert.equal(init.headers['X-Figma-Token'], 'figma-token');
    if (url.pathname.endsWith('/versions')) return json({ versions: VERSIONS, pagination: {} });
    if (url.pathname.startsWith('/v1/images/')) {
      const ids = url.searchParams.get('ids').split(',');
      return json({ err: null, images: Object.fromEntries(ids.map((id) => [id, `https://s3.example/${v}/${id}.png`])) });
    }
    const snap = SNAP[v || '300'];
    if (url.searchParams.get('depth') === '1') {
      return json({ name: 'Acme', document: { children: [...snap.pages, { id: '0:9', name: 'Archive' }] } });
    }
    return json({ name: 'Acme', document: { children: snap.pages }, components: snap.components, componentSets: snap.componentSets, styles: {} });
  }
  if (url.host === 's3.example') return new Response(PNG);
  if (url.host === 'chat.googleapis.com') return json({ name: 'spaces/x/messages/y' });
  if (url.host === 'slack.com') {
    if (failSlack) return json({ ok: false, error: 'channel_not_found' });
    return json({ ok: true, ts: '111.222' });
  }
  if (url.host === 'api.telegram.org') {
    assert.ok(url.pathname.startsWith('/botTG-TOKEN/'));
    if (url.pathname.endsWith('/getUpdates')) {
      return json({ ok: true, result: [{ my_chat_member: { chat: { id: -1001234, title: 'Design team', type: 'supergroup' } } }] });
    }
    return json({ ok: true, result: { message_id: 42 } });
  }
  throw new Error(`unexpected request ${url}`);
}

const ENV = {
  FIGMA_TOKEN: 'figma-token',
  FIGMA_FILE_KEY: 'https://www.figma.com/design/AbC123/Acme?node-id=0-1',
  GCHAT_WEBHOOK_URL: 'https://chat.googleapis.com/v1/spaces/x/messages?key=k&token=t',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_CHANNEL_ID: 'C123',
  TELEGRAM_BOT_TOKEN: 'TG-TOKEN',
  TELEGRAM_CHAT_ID: '-100',
};

const run = async (argv, env = ENV) => {
  const lines = [];
  const code = await main(argv, { root, env, log: (s) => lines.push(String(s)) });
  return { code, out: lines.join('\n') };
};
const state = () => JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'));

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'figma-changelog-'));
  writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ watchedPagePrefixes: ['Mobile'], timezone: 'Africa/Johannesburg', labels: { before: 'قبل', after: 'بعد', new: 'جديد' } }),
  );
  writeFileSync(path.join(root, 'variables-map.json'), JSON.stringify({ 'VariableID:1:23': 'brand/600' }));
  calls = [];
  failSlack = false;
  globalThis.fetch = fakeFetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

test('first run only saves a baseline and posts nothing', async () => {
  const { code, out } = await run([]);
  assert.equal(code, 0);
  assert.match(out, /First run/);
  assert.deepEqual(state().channels, { gchat: '300', slack: '300', telegram: '300' });
  assert.equal(calls.filter((c) => c.url.host !== 'api.figma.com').length, 0);
});

test('posts new versions to every channel, writes CHANGELOG and pictures', async () => {
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ lastProcessed: '100', channels: { gchat: '100', slack: '100', telegram: '100' } }));
  const { code, out } = await run([]);
  assert.equal(code, 0, out);
  assert.match(out, /200 .*\n.*no meaningful changes/);
  assert.deepEqual(state().channels, { gchat: '300', slack: '300', telegram: '300' });
  assert.equal(state().lastProcessed, '300');

  // Only the watched page was fetched in full
  const treeCalls = calls.filter((c) => c.url.host === 'api.figma.com' && c.url.searchParams.get('ids') && !c.url.pathname.startsWith('/v1/images'));
  assert.ok(treeCalls.every((c) => c.url.searchParams.get('ids') === '0:1'));

  // Google Chat: main card in a thread, with a before/after pair
  const chat = calls.filter((c) => c.url.host === 'chat.googleapis.com');
  assert.ok(chat.length >= 2);
  assert.equal(chat[0].url.searchParams.get('threadKey'), 'changelog-300');
  assert.equal(chat[0].url.searchParams.get('messageReplyOption'), 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
  const card = chat[0].body.cardsV2[0].card;
  assert.match(card.header.title, /Acme.*: \d+ changes · .*Alex.* · Tue 10 Nov, 11:30/);
  assert.match(JSON.stringify(card), /جديد/); // added frame first, labelled with the configured "new" label

  // Slack: replies go into the thread of the first message
  const slackCalls = calls.filter((c) => c.url.host === 'slack.com');
  assert.equal(slackCalls[0].body.thread_ts, undefined);
  assert.ok(slackCalls.slice(1).every((c) => c.body.thread_ts === '111.222'));

  // Telegram: summary, then albums replying to it
  const tg = calls.filter((c) => c.url.host === 'api.telegram.org');
  assert.ok(tg[0].url.pathname.endsWith('/sendMessage'));
  assert.ok(tg.slice(1).every((c) => c.body.reply_parameters?.message_id === 42));
  assert.ok(tg.some((c) => c.url.pathname.endsWith('/sendMediaGroup')));

  // CHANGELOG + saved pictures
  const log = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(log, /## Tue 10 Nov, 11:30 · Alex/);
  assert.match(log, /text changed\n    - قبل: «\u2068مرحبا\u2069»\n    - بعد: «\u2068أهلاً وسهلاً\u2069»/);
  assert.match(log, /brand\/600/);
  assert.ok(existsSync(path.join(root, 'changelog-images/2026-11-10-300/1-1-after.png')));
  assert.ok(existsSync(path.join(root, 'changelog-images/2026-11-10-300/1-1-before.png')));
  assert.ok(existsSync(path.join(root, 'changelog-images/2026-11-10-300/3-1-after.png')));
  assert.ok(!existsSync(path.join(root, 'changelog-images/2026-11-10-300/3-1-before.png')));

  // Secrets never appear in the log
  for (const secret of ['figma-token', 'xoxb-test', 'TG-TOKEN', 'token=t']) assert.ok(!out.includes(secret), secret);

  // Running again posts nothing
  calls = [];
  const again = await run([]);
  assert.match(again.out, /Nothing new/);
  assert.equal(calls.filter((c) => c.url.host !== 'api.figma.com').length, 0);
});

test('a failing channel keeps its place; the others move on', async () => {
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ lastProcessed: '200', channels: { gchat: '200', slack: '200', telegram: '200' } }));
  failSlack = true;
  const { code, out } = await run([]);
  assert.equal(code, 1);
  assert.match(out, /Slack failed: Slack main message: channel_not_found/);
  assert.deepEqual(state().channels, { gchat: '300', slack: '200', telegram: '300' });

  // Next run: only Slack gets version 300, CHANGELOG is not written twice
  failSlack = false;
  calls = [];
  const again = await run([]);
  assert.equal(again.code, 0, again.out);
  assert.equal(calls.filter((c) => c.url.host === 'chat.googleapis.com' || c.url.host === 'api.telegram.org').length, 0);
  assert.ok(calls.some((c) => c.url.host === 'slack.com'));
  assert.equal(readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').match(/^## /gm).length, 1);
  assert.equal(state().channels.slack, '300');
});

test('channel without secrets is off; new channel starts at the current version', async () => {
  writeFileSync(path.join(root, 'state.json'), JSON.stringify({ lastProcessed: '200', channels: { gchat: '200' } }));
  const env = { ...ENV };
  delete env.SLACK_BOT_TOKEN;
  const { code, out } = await run([], env);
  assert.equal(code, 0, out);
  assert.match(out, /Channel Slack: off \(no secrets\)/);
  assert.match(out, /Telegram is new/);
  assert.equal(calls.filter((c) => c.url.host === 'api.telegram.org').length, 0);
  assert.equal(calls.filter((c) => c.url.host === 'slack.com').length, 0);
  assert.ok(calls.some((c) => c.url.host === 'chat.googleapis.com'));
});

test('dry run previews all channels and saves no state', async () => {
  const env = { FIGMA_TOKEN: 'figma-token', FIGMA_FILE_KEY: 'AbC123' };
  const { code, out } = await run(['--dry-run'], env);
  assert.equal(code, 0, out);
  assert.match(out, /DRY RUN/);
  assert.match(out, /--- Google Chat: \d+ message/);
  assert.match(out, /--- Slack: \d+ message/);
  assert.match(out, /--- Telegram: \d+ message/);
  assert.ok(!existsSync(path.join(root, 'state.json')));
  assert.ok(!existsSync(path.join(root, 'CHANGELOG.md')));
  assert.ok(existsSync(path.join(root, '.dry-run/300/gchat.json')));
  assert.equal(calls.filter((c) => !['api.figma.com', 's3.example'].includes(c.url.host)).length, 0);
});

test('missing Figma secrets stop early with a clear message', async () => {
  const { code, out } = await run([], {});
  assert.equal(code, 2);
  assert.match(out, /Missing FIGMA_TOKEN and FIGMA_FILE_KEY/);
});

test('--send-test posts once to configured channels, marked TEST, and saves nothing', async () => {
  const env = { ...ENV };
  delete env.SLACK_BOT_TOKEN;
  const { code, out } = await run(['--send-test'], env);
  assert.equal(code, 0, out);
  const chat = calls.filter((c) => c.url.host === 'chat.googleapis.com');
  assert.match(chat[0].body.cardsV2[0].card.header.title, /^🧪 TEST · /);
  assert.match(chat[0].url.searchParams.get('threadKey'), /^changelog-300-test-[a-z0-9]+$/);
  assert.ok(chat.every((c) => c.url.searchParams.get('threadKey') === chat[0].url.searchParams.get('threadKey')));
  assert.ok(calls.some((c) => c.url.host === 'api.telegram.org'));
  assert.ok(!calls.some((c) => c.url.host === 'slack.com'));
  assert.ok(!existsSync(path.join(root, 'state.json')));
  assert.ok(!existsSync(path.join(root, 'CHANGELOG.md')));
});

test('--send-test --only limits to one channel', async () => {
  const { code } = await run(['--send-test', '--only', 'telegram']);
  assert.equal(code, 0);
  assert.ok(!calls.some((c) => ['chat.googleapis.com', 'slack.com'].includes(c.url.host)));
});

test('--telegram-chat-id lists groups without needing Figma', async () => {
  const { code, out } = await run(['--telegram-chat-id'], { TELEGRAM_BOT_TOKEN: 'TG-TOKEN' });
  assert.equal(code, 0);
  assert.match(out, /Design team \(supergroup\)  →  TELEGRAM_CHAT_ID=-1001234/);
  assert.ok(!out.includes('TG-TOKEN'));
});
