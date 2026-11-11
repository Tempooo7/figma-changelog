// state.json: which Figma version each channel has received.
//   lastProcessed  newest version written to CHANGELOG.md
//   channels       { gchat: versionId, slack: versionId, telegram: versionId }
import path from 'node:path';
import { readJson, writeJson } from './config.js';

export const statePath = (root) => path.join(root, 'state.json');

export function loadState(root) {
  return readJson(statePath(root), null);
}

export function saveState(root, state) {
  writeJson(statePath(root), { ...state, lastRunAt: new Date().toISOString() });
}
