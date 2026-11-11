import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compare, toHex } from '../src/diff.js';
import { describeFrame } from '../src/describe.js';
import { snapshotV1, snapshotV2 } from './fixtures.js';

const vars = { 'VariableID:1:23': 'brand/600' };

test('no changes between identical versions', () => {
  assert.deepEqual(compare(snapshotV1(), snapshotV1()).frames, []);
});

test('reports added, deleted, renamed and changed frames', () => {
  const { frames } = compare(snapshotV1(), snapshotV2(), { variables: vars });
  const byName = Object.fromEntries(frames.map((f) => [f.name, f]));
  assert.equal(byName['Approvals'].status, 'added');
  assert.equal(byName['Old screen'].status, 'deleted');
  assert.equal(byName['Settings v2'].status, 'changed');
  assert.deepEqual(byName['Settings v2'].changes.map((c) => c.kind), ['frame-renamed']);
  assert.equal(byName['Home'].status, 'changed');
  assert.equal(frames.at(-1).name, 'Old screen', 'deleted frames come last');
});

test('detects text, colour, padding, variant, visibility and layer changes; ignores noise', () => {
  const { frames } = compare(snapshotV1(), snapshotV2(), { variables: vars });
  const home = frames.find((f) => f.name === 'Home');
  const kinds = home.changes.map((c) => `${c.kind}:${c.node ?? ''}`).sort();
  assert.deepEqual(kinds, [
    'fill:CTA',
    'layers-added:',
    'layers-removed:',
    'padding:Card',
    'text:Title',
    'variant:Button',
    'visibility:Hint',
  ]);
  const text = home.changes.find((c) => c.kind === 'text');
  assert.equal(text.old, 'مرحبا');
  assert.equal(text.new, 'أهلاً وسهلاً');
  assert.deepEqual(
    { old: home.changes.find((c) => c.kind === 'fill').old, new: home.changes.find((c) => c.kind === 'fill').new },
    { old: '#1A73E8', new: 'brand/600' },
  );
  const variant = home.changes.find((c) => c.kind === 'variant');
  assert.deepEqual([variant.prop, variant.old, variant.new], ['State', 'Default', 'Hover']);
  assert.deepEqual(home.changes.find((c) => c.kind === 'padding'), {
    kind: 'padding', node: 'Card', old: '12', new: '12 16', sides: [['right', '12', '16'], ['left', '12', '16']],
  });
});

test('unknown variable falls back to hex', () => {
  const { frames } = compare(snapshotV1(), snapshotV2(), { variables: {} });
  const fill = frames.find((f) => f.name === 'Home').changes.find((c) => c.kind === 'fill');
  assert.deepEqual([fill.old, fill.new], ['#1A73E8', '#0B57D0']);
});

test('fixed-size changes are reported, hug sizes are not', () => {
  const a = snapshotV1();
  const b = snapshotV1();
  b.pages[0].children[0].children[2].absoluteBoundingBox.width = 300; // Card width is FIXED (counter axis)
  const card = compare(a, b).frames[0].changes.find((c) => c.kind === 'size');
  assert.deepEqual([card.node, card.old, card.new], ['Card', '343×200', '300×200']);
});

test('instance swap to another component', () => {
  const a = snapshotV1();
  const b = snapshotV1();
  b.components['7:1'] = { name: 'Chip' };
  b.pages[0].children[0].children[3].componentId = '7:1';
  const swap = compare(a, b).frames[0].changes.find((c) => c.kind === 'swap');
  assert.deepEqual([swap.old, swap.new], ['Button (State=Default)', 'Chip']);
});

const LABELS = { before: 'Before', after: 'After' };

test('Arabic text changes go on separate Before/After lines', () => {
  const lines = describeFrame({ changes: [{ kind: 'text', node: 'Title', old: 'مرحبا', new: 'أهلاً' }] }, LABELS);
  assert.deepEqual(lines, ['\u2068Title\u2069: text changed\nBefore: «\u2068مرحبا\u2069»\nAfter: «\u2068أهلاً\u2069»']);
});

test('short English text changes stay on one line', () => {
  const lines = describeFrame({ changes: [{ kind: 'text', node: null, old: 'Save', new: 'Save draft' }] }, LABELS);
  assert.deepEqual(lines, ['Text changed «\u2068Save\u2069» → «\u2068Save draft\u2069»']);
});

test('identical changes on several layers are merged; structure comes first', () => {
  const lines = describeFrame({
    changes: [
      { kind: 'fill', node: 'A', old: '#000000', new: 'brand/600' },
      { kind: 'fill', node: 'B', old: '#000000', new: 'brand/600' },
      { kind: 'fill', node: 'C', old: '#000000', new: 'brand/600' },
      { kind: 'stroke', node: 'Card', old: 'none', new: '#EDEFF1' },
      { kind: 'padding', node: 'Content', old: '0', new: '0 0 111 0', sides: [['bottom', '0', '111']] },
      { kind: 'layers-added', count: 2, names: ['Divider', 'Link row'] },
    ],
  }, LABELS);
  assert.equal(lines[0], 'Added: \u2068Divider\u2069, \u2068Link row\u2069');
  assert.ok(lines.includes('\u2068A\u2069, \u2068B\u2069 +1 more: colour #000000 → brand/600'), lines.join('|'));
  assert.ok(lines.includes('\u2068Card\u2069: border added: #EDEFF1'));
  assert.ok(lines.includes('\u2068Content\u2069: bottom padding 0 → 111'));
});

test('toHex handles alpha', () => {
  assert.equal(toHex({ r: 1, g: 0, b: 0, a: 1 }), '#FF0000');
  assert.equal(toHex({ r: 0, g: 0, b: 0, a: 1 }, 0.5), '#000000 50%');
});

test('auto-named text layers are not repeated in front of the change', () => {
  const a = snapshotV1();
  const b = snapshotV1();
  const t = b.pages[0].children[0].children[4]; // "Hint"
  a.pages[0].children[0].children[4].name = 'hint';
  t.name = 'new hint';
  t.characters = 'new hint';
  const c = compare(a, b).frames[0].changes.find((x) => x.kind === 'text');
  assert.equal(c.node, null);
});

test('several tiny text edits fold into one line', () => {
  const lines = describeFrame({
    changes: [
      { kind: 'text', node: null, old: 'م ع', new: 'م' },
      { kind: 'text', node: null, old: 'أ س', new: 'أ' },
      { kind: 'text', node: null, old: 'Save', new: 'Send' },
      { kind: 'text', node: null, old: 'Long sentence here', new: 'Shorter one' },
    ],
  }, { before: 'Before', after: 'After' });
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '3 short texts changed (1–4 letters each, see the pictures)');
});
