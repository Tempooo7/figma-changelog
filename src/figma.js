import { requestJson, request } from './http.js';

const API = 'https://api.figma.com';

export function figmaFileUrl(fileKey, nodeId) {
  const base = `https://www.figma.com/design/${fileKey}`;
  return nodeId ? `${base}?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}` : base;
}

export class FigmaClient {
  constructor({ token, fileKey, log = console.log }) {
    this.token = token;
    this.fileKey = fileKey;
    this.log = log;
    this.calls = 0;
    this.throttled = 0;
  }

  async get(pathAndQuery, label) {
    this.calls++;
    return requestJson(
      `${API}${pathAndQuery}`,
      { headers: { 'X-Figma-Token': this.token } },
      {
        label: `Figma ${label}`,
        tries: 6,
        log: this.log,
        onRateLimit: (res) => {
          this.throttled++;
          const h = (n) => res.headers.get(n);
          this.log(
            `Figma rate limit hit. plan tier: ${h('x-figma-plan-tier') || '?'}, ` +
              `limit type: ${h('x-figma-rate-limit-type') || '?'}` +
              (h('x-figma-rate-limit-type') === 'low'
                ? ' → this token belongs to a View/Collab seat. Use a token from a Full or Dev seat.'
                : ''),
          );
        },
      },
    );
  }

  /**
   * Versions, newest first. Pages back (page_size 50) until every id in `stopAt`
   * has been seen, or history ends, or `maxPages` is reached.
   */
  async getVersions(stopAt = new Set(), maxPages = 20) {
    const out = [];
    const want = new Set([...stopAt].filter(Boolean));
    let before = '';
    for (let page = 0; page < maxPages; page++) {
      const q = new URLSearchParams({ page_size: '50' });
      if (before) q.set('before', before);
      const data = await this.get(`/v1/files/${this.fileKey}/versions?${q}`, 'versions');
      const list = data.versions || [];
      let added = 0;
      for (const v of list) {
        if (out.some((x) => x.id === v.id)) continue;
        out.push(v);
        want.delete(v.id);
        added++;
      }
      if (!want.size || !added) break;
      before = list[list.length - 1].id;
    }
    return out;
  }

  /** Page list (id, name) of a version, plus the file name. */
  async getPages(versionId) {
    const q = new URLSearchParams({ depth: '1' });
    if (versionId) q.set('version', versionId);
    const data = await this.get(`/v1/files/${this.fileKey}?${q}`, `pages @${versionId || 'latest'}`);
    return {
      fileName: data.name,
      pages: (data.document?.children || []).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  /** Full trees of the given pages at a version, with the components/styles lookup maps. */
  async getPageTrees(versionId, pageIds) {
    if (!pageIds.length) return { pages: [], components: {}, componentSets: {}, styles: {} };
    const q = new URLSearchParams({ ids: pageIds.join(','), version: versionId });
    const data = await this.get(`/v1/files/${this.fileKey}?${q}`, `page trees @${versionId}`);
    const wanted = new Set(pageIds);
    return {
      pages: (data.document?.children || []).filter((p) => wanted.has(p.id)),
      components: data.components || {},
      componentSets: data.componentSets || {},
      styles: data.styles || {},
    };
  }

  /** { nodeId: pngUrl | null } rendered at a given version. Small batches so big frames don't time out. */
  async getImageUrls(ids, versionId, scale = 2) {
    const result = {};
    const batches = chunk(ids, 5);
    for (const batch of batches) {
      try {
        Object.assign(result, await this.renderBatch(batch, versionId, scale));
      } catch (e) {
        if (batch.length === 1) {
          this.log(`  no picture for ${batch[0]} @${versionId}: ${e.message}`);
          result[batch[0]] = null;
          continue;
        }
        // One frame can break the whole batch; render them one by one instead.
        for (const id of batch) {
          try {
            Object.assign(result, await this.renderBatch([id], versionId, scale));
          } catch (e2) {
            this.log(`  no picture for ${id} @${versionId}: ${e2.message}`);
            result[id] = null;
          }
        }
      }
    }
    return result;
  }

  async renderBatch(ids, versionId, scale) {
    const q = new URLSearchParams({ ids: ids.join(','), format: 'png', scale: String(scale), version: versionId });
    const data = await this.get(`/v1/images/${this.fileKey}?${q}`, `render @${versionId}`);
    if (data.err) throw new Error(String(data.err));
    return data.images || {};
  }

  /** Download a rendered PNG (public S3 link, no token needed). */
  async download(url) {
    const res = await request(url, {}, { label: 'Figma picture download', tries: 4, log: this.log });
    return Buffer.from(await res.arrayBuffer());
  }
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
