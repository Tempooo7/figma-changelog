// Telegram: bot from @BotFather.
// 1) text summary (HTML) with an "Open in Figma" button
// 2) main before/after pair as a 2-photo album, sent as a reply to the summary
// 3) one album per remaining frame, also as replies
// Pictures are sent as Figma links; if Telegram can't fetch one, the saved PNG is uploaded instead.
import { readFileSync } from 'node:fs';
import { requestJson, sleep } from '../http.js';
import { escapeHtml as h, pictureLabel, moreText, fitLines } from './common.js';
import { groupTitle } from '../describe.js';

function summaryHtml(update) {
  const lines = [`<b>${h(update.title)}</b>`];
  const note = [update.version.label, update.version.description].filter(Boolean).join(' — ');
  if (note) lines.push(`<i>${h(note)}</i>`);
  for (const page of update.pages) {
    lines.push('', `<b>${h(page.name)}</b>`);
    for (const g of page.groups) {
      lines.push(`• ${groupTitle(g, (f) => `<a href="${h(f.url)}">${h(f.name)}</a>`)}`);
      for (const l of g.lines) {
        const [first, ...rest] = l.split('\n');
        lines.push(`    – ${h(first)}`, ...rest.map((r) => `        ${h(r)}`));
      }
      if (g.hiddenLines) lines.push(`    – …and ${g.hiddenLines} more`);
    }
  }
  const more = moreText(update, true).replace('in the thread', 'below');
  if (more) lines.push('', `<i>${h(more)}</i>`);
  return fitLines(lines, 4000).join('\n');
}

function caption(pair, labels) {
  const parts = ['before', 'after'].filter((w) => pair[w]).map((w) => pictureLabel(pair, w, labels));
  return `<a href="${h(pair.frame.url)}"><b>${h(pair.frame.name)}</b></a> · ${h(parts.join(' | '))}`;
}

export function buildCalls(update, env = {}) {
  const L = update.labels;
  const topic = env.TELEGRAM_TOPIC_ID ? { message_thread_id: Number(env.TELEGRAM_TOPIC_ID) } : {};
  const [main] = update.pairs;
  const calls = [
    {
      method: 'sendMessage',
      payload: {
        chat_id: env.TELEGRAM_CHAT_ID || '<TELEGRAM_CHAT_ID>',
        text: summaryHtml(update),
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: [[{ text: L.openInFigma, url: main ? main.frame.url : update.fileUrl }]] },
        ...topic,
      },
    },
  ];
  for (const pair of update.pairs) {
    const pics = ['before', 'after'].filter((w) => pair[w]?.url).map((w) => ({ which: w, ...pair[w] }));
    if (!pics.length) continue;
    calls.push({ method: pics.length === 2 ? 'sendMediaGroup' : 'sendPhoto', pair, pics, caption: caption(pair, L), topic });
  }
  return calls;
}

/** Payload for a picture call; replyTo is the summary's message_id. */
function photoPayload(call, chatId, replyTo, mode /* 'url' | 'upload' | 'document' */) {
  const reply = replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
  const src = (p, i) => (mode === 'url' ? p.url : `attach://pic${i}`);
  const type = mode === 'document' ? 'document' : 'photo';
  if (call.method === 'sendMediaGroup') {
    return {
      method: 'sendMediaGroup',
      payload: {
        chat_id: chatId,
        media: call.pics.map((p, i) => ({ type, media: src(p, i), ...(i === 0 ? { caption: call.caption, parse_mode: 'HTML' } : {}) })),
        ...reply,
        ...call.topic,
      },
    };
  }
  const field = type === 'document' ? 'document' : 'photo';
  return {
    method: type === 'document' ? 'sendDocument' : 'sendPhoto',
    payload: { chat_id: chatId, [field]: src(call.pics[0], 0), caption: call.caption, parse_mode: 'HTML', ...reply, ...call.topic },
  };
}

const URL_PROBLEM = /wrong file identifier|failed to get http url content|wrong type of the web page|webpage_media_empty|wrong remote file|too big/i;
const SIZE_PROBLEM = /PHOTO_INVALID_DIMENSIONS|IMAGE_PROCESS_FAILED|photo_save_file_invalid/i;

export default {
  name: 'telegram',
  title: 'Telegram',
  isConfigured: (env) => Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID),

  preview(update, { env = {} } = {}) {
    return buildCalls(update, env).map((c, i) =>
      c.payload
        ? { to: `Telegram ${c.method}`, body: c.payload }
        : { to: `Telegram ${c.method} (reply to message 1)`, body: photoPayload(c, env.TELEGRAM_CHAT_ID || '<TELEGRAM_CHAT_ID>', i ? '<message_id of message 1>' : null, 'url').payload },
    );
  },

  async send(update, { env, log = () => {} }) {
    // The token is part of the URL, so labels never include the URL.
    const call = async (method, payload, files) => {
      let init;
      if (files) {
        const form = new FormData();
        for (const [k, v] of Object.entries(payload)) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        for (const [name, abs] of files) form.append(name, new Blob([readFileSync(abs)], { type: 'image/png' }), `${name}.png`);
        init = { method: 'POST', body: form };
      } else {
        init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
      }
      const data = await requestJson(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, init, {
        label: `Telegram ${method}`,
        tries: 4,
        log,
        retryAfter: (_res, body) => {
          try {
            return JSON.parse(body).parameters?.retry_after;
          } catch {
            return undefined;
          }
        },
      });
      if (!data.ok) throw new Error(`Telegram ${method}: ${data.description || 'not ok'}`);
      return data.result;
    };

    const calls = buildCalls(update, env);
    const first = await call(calls[0].method, calls[0].payload);
    const replyTo = first.message_id;
    let sent = 1;

    for (const c of calls.slice(1)) {
      await sleep(1500); // stay well under ~20 messages/minute per group
      const viaUrl = photoPayload(c, env.TELEGRAM_CHAT_ID, replyTo, 'url');
      try {
        await call(viaUrl.method, viaUrl.payload);
      } catch (e) {
        const canUpload = c.pics.every((p) => p.abs);
        if (!canUpload || !(URL_PROBLEM.test(e.message) || SIZE_PROBLEM.test(e.message))) throw e;
        const files = c.pics.map((p, i) => [`pic${i}`, p.abs]);
        const mode = SIZE_PROBLEM.test(e.message) ? 'document' : 'upload';
        log(`  Telegram couldn't use the picture link for “${c.pair.frame.name}”; uploading the saved PNG${mode === 'document' ? ' as a file' : ''}`);
        try {
          const up = photoPayload(c, env.TELEGRAM_CHAT_ID, replyTo, mode);
          await call(up.method, up.payload, files);
        } catch (e2) {
          if (mode === 'document' || !SIZE_PROBLEM.test(e2.message)) throw e2;
          const doc = photoPayload(c, env.TELEGRAM_CHAT_ID, replyTo, 'document');
          await call(doc.method, doc.payload, files);
        }
      }
      sent++;
    }
    return sent;
  },
};
