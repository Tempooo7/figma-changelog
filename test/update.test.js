import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdate } from '../src/update.js';
import { renderPlain } from '../src/describe.js';

const cfg = { labels: { before: 'Before', after: 'After', new: 'New', deleted: 'Deleted' }, maxLinesPerFrame: 8, timezone: 'UTC', projectName: 'App' };
const shared = { kind: 'padding', node: 'Content', old: '0 0 141 0', new: '0 0 111 0', sides: [['bottom', '141', '111']] };
const frame = (id, name, extra = []) => ({ id, name, page: 'P', status: 'changed', changes: [shared, ...extra] });

test('a change made in several frames is shown once, under all of them', () => {
  const diff = {
    frames: [
      frame('1:1', 'A'),
      frame('1:2', 'B', [{ kind: 'visibility', node: 'X', old: true, new: false }]),
      frame('1:3', 'C'),
      { id: '1:4', name: 'D', page: 'P', status: 'added', changes: [] },
    ],
  };
  const u = buildUpdate({ cfg, fileKey: 'K', version: { id: '9', created_at: '2026-11-11T10:00:00Z', user: { handle: 'T' } }, prevVersionId: '8', diff });
  const groups = u.pages[0].groups;
  assert.deepEqual(groups.map((g) => g.frames.map((f) => f.name)), [['A', 'B', 'C'], ['B'], ['D']]);
  assert.deepEqual(groups[0].lines, ['⁨Content⁩: bottom padding 141 → 111']);
  assert.deepEqual(groups[1].lines, ['⁨X⁩: now hidden']);
  const text = renderPlain(u);
  assert.match(text, /Same change in 3 frames: A, B, C\n {7}– .*bottom padding 141 → 111/);
  assert.match(text, /• D \(New\)/);
});
