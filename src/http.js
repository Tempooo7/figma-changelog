// Small fetch wrapper with retries for rate limits (429) and server/network errors.

export class HttpError extends Error {
  constructor(message, status = 0, body = '') {
    super(message);
    this.status = status;
    this.body = body;
  }
}

let sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
export const sleep = (ms) => sleepImpl(ms);
/** Tests replace the sleep function so retries run instantly. */
export function setSleep(fn) {
  sleepImpl = fn;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {object} o
 * @param {string} o.label        what to call this request in logs (never contains secrets)
 * @param {number} [o.tries]      total attempts
 * @param {number} [o.maxWaitSec] give up if the server asks us to wait longer than this
 * @param {(res: Response, body: string) => number|undefined} [o.retryAfter] seconds to wait on 429
 * @param {(res: Response) => void} [o.onRateLimit]
 * @param {(msg: string) => void} [o.log]
 */
export async function request(url, init = {}, o = {}) {
  const { label = 'request', tries = 5, maxWaitSec = 300, log = () => {} } = o;
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const backoff = Math.min(60, 2 ** attempt);
    let res;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      lastError = new HttpError(`${label}: network error (${e.cause?.code || e.name || e.message})`);
      if (attempt < tries) {
        log(`${label}: network error, retrying in ${backoff}s (${attempt}/${tries})`);
        await sleep(backoff * 1000);
      }
      continue;
    }
    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    if (res.status === 429) {
      o.onRateLimit?.(res);
      const asked = o.retryAfter?.(res, body) ?? Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(asked) && asked > 0 ? asked : backoff;
      lastError = new HttpError(`${label}: rate limited (429), server asked to wait ${wait}s`, 429, body);
      if (wait > maxWaitSec) {
        lastError.message += ` — longer than ${maxWaitSec}s, giving up for this run`;
        throw lastError;
      }
      if (attempt < tries) {
        log(`${label}: THROTTLED (429), waiting ${wait}s (${attempt}/${tries})`);
        await sleep(wait * 1000);
      }
      continue;
    }
    if (res.status >= 500) {
      lastError = new HttpError(`${label}: server error ${res.status}`, res.status, body);
      if (attempt < tries) {
        log(`${label}: server error ${res.status}, retrying in ${backoff}s (${attempt}/${tries})`);
        await sleep(backoff * 1000);
      }
      continue;
    }
    throw new HttpError(`${label}: HTTP ${res.status} ${trim(body)}`, res.status, body);
  }
  throw lastError || new HttpError(`${label}: failed`);
}

export async function requestJson(url, init, o) {
  const res = await request(url, init, o);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${o?.label || 'request'}: response was not JSON: ${trim(text)}`, res.status, text);
  }
}

function trim(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? t.slice(0, 300) + '…' : t;
}
