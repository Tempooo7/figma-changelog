import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { request, setSleep } from '../src/http.js';
import { parseFileKey, pageMatches, cleanSecrets, describeSecretShape } from '../src/config.js';

const realFetch = globalThis.fetch;
const waits = [];
setSleep((ms) => {
  waits.push(ms);
  return Promise.resolve();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  waits.length = 0;
});

const sequence = (...responses) => {
  let i = 0;
  globalThis.fetch = async () => {
    const r = responses[i++];
    if (r instanceof Error) throw r;
    return r;
  };
};

test('429 waits for Retry-After, then succeeds', async () => {
  sequence(new Response('', { status: 429, headers: { 'retry-after': '7' } }), new Response('ok'));
  const res = await request('https://x', {}, { label: 't' });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(waits, [7000]);
});

test('429 asking to wait too long gives up', async () => {
  sequence(new Response('', { status: 429, headers: { 'retry-after': '86400' } }));
  await assert.rejects(request('https://x', {}, { label: 't' }), /giving up/);
});

test('5xx and network errors back off and retry', async () => {
  sequence(new Response('', { status: 502 }), new TypeError('fetch failed'), new Response('ok'));
  const res = await request('https://x', {}, { label: 't' });
  assert.equal(await res.text(), 'ok');
  assert.deepEqual(waits, [2000, 4000]);
});

test('4xx fails immediately with the reason', async () => {
  sequence(new Response('{"err":"Invalid token"}', { status: 403 }));
  await assert.rejects(request('https://x', {}, { label: 'Figma versions' }), /Figma versions: HTTP 403 .*Invalid token/);
});

test('parseFileKey accepts links and bare keys', () => {
  assert.equal(parseFileKey('https://www.figma.com/design/AbC123/My-File?node-id=1-2'), 'AbC123');
  assert.equal(parseFileKey('https://www.figma.com/file/XyZ9/Old'), 'XyZ9');
  assert.equal(parseFileKey('https://www.figma.com/design/AbC123/branch/BrN7/My-File'), 'BrN7');
  assert.equal(parseFileKey('AbC123'), 'AbC123');
  assert.equal(parseFileKey('not a key!'), '');
  assert.equal(parseFileKey('FIGMA_FILE_KEY=AbCdEfGhIjKlMnOpQrStUv'), 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseFileKey(' "AbCdEfGhIjKlMnOpQrStUv"\n'), 'AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(parseFileKey('key: AbCdEfGhIjKlMnOpQrStUv (my file)'), 'AbCdEfGhIjKlMnOpQrStUv');
});

test('page names match despite emoji codes, extra spaces and case', () => {
  const page = '\u25B6\uFE0F  2.0  Checkout · full flow (Light)';
  assert.ok(pageMatches(page, ['▶️ 2.0 Checkout · full flow (Light)']));
  assert.ok(pageMatches(page, ['\u25B6 2.0 checkout']));
  assert.ok(!pageMatches('▶️  2.0  Checkout · full flow (Dark)', ['▶️ 2.0 Checkout · full flow (Light)']));
  assert.ok(pageMatches('Anything', []));
});

test('secrets are cleaned of common pasting mistakes; shape never reveals the value', () => {
  const env = cleanSecrets({ FIGMA_TOKEN: ' FIGMA_TOKEN=figd_abc123 \n', GCHAT_WEBHOOK_URL: '"https://chat.googleapis.com/x"', OTHER: ' keep ' });
  assert.equal(env.FIGMA_TOKEN, 'figd_abc123');
  assert.equal(env.GCHAT_WEBHOOK_URL, 'https://chat.googleapis.com/x');
  assert.equal(env.OTHER, ' keep ');
  const shape = describeSecretShape('FIGMA_TOKEN=figd_secret ');
  assert.ok(!shape.includes('secret'));
  assert.match(shape, /contains "="/);
});
