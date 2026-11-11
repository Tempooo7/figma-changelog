// Slack: Block Kit.
// Bot mode (SLACK_BOT_TOKEN + SLACK_CHANNEL_ID): main message, then replies in its thread (thread_ts).
// Webhook mode (SLACK_WEBHOOK_URL): Slack webhooks can't make threads, so everything goes in one message.
import { requestJson, request, sleep } from '../http.js';
import { pictureLabel, moreText } from './common.js';
import { clip, groupTitle } from '../describe.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = (url, text) => `<${url}|${esc(text).replace(/\|/g, '¦')}>`;
const plain = (text, max = 2000) => ({ type: 'plain_text', text: clip(text, max), emoji: true });

function summarySections(update) {
  const lines = [];
  for (const page of update.pages) {
    lines.push(`*${esc(page.name)}*`);
    for (const g of page.groups) {
      lines.push(`• ${groupTitle(g, (f) => link(f.url, f.name))}`);
      for (const l of g.lines) {
        const [first, ...rest] = l.split('\n');
        lines.push(`      – ${esc(first)}`, ...rest.map((r) => `            ${esc(r)}`));
      }
      if (g.hiddenLines) lines.push(`      – …and ${g.hiddenLines} more`);
    }
  }
  // Section text is limited to 3000 characters; split into several sections.
  const sections = [];
  let buf = '';
  for (const l of lines) {
    if (buf && buf.length + l.length + 1 > 2900) {
      sections.push(buf);
      buf = '';
    }
    buf += (buf ? '\n' : '') + l;
  }
  if (buf) sections.push(buf);
  return sections.slice(0, 10).map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } }));
}

function pairBlocks(pair, labels, withTitle, images = true) {
  const blocks = [];
  if (withTitle) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${link(pair.frame.url, pair.frame.name)}* · ${esc(pair.frame.page)}` } });
  }
  for (const which of ['before', 'after']) {
    const pic = pair[which];
    if (!pic?.url) continue;
    const label = `${pictureLabel(pair, which, labels)} · ${pair.frame.name}`;
    blocks.push(
      images
        ? { type: 'image', image_url: pic.url, alt_text: clip(label, 2000), title: plain(label) }
        : { type: 'section', text: { type: 'mrkdwn', text: link(pic.url, `🖼 ${label}`) } },
    );
  }
  return blocks;
}

/** @returns {{ main: object[], replies: object[][] }} lists of blocks */
export function buildBlocks(update, { threads = true, images = true } = {}) {
  const L = update.labels;
  const [main, ...rest] = update.pairs;
  const blocks = [{ type: 'header', text: plain(update.title, 150) }];
  const note = [update.version.label, update.version.description].filter(Boolean).join(' — ');
  if (note) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${esc(clip(note, 2900))}_` }] });
  blocks.push(...summarySections(update));
  if (main) blocks.push({ type: 'divider' }, ...pairBlocks(main, L, true, images));
  if (!threads) {
    for (const pair of rest) {
      if (blocks.length + 4 > 49) break; // Slack allows max 50 blocks per message
      blocks.push(...pairBlocks(pair, L, true, images));
    }
  }
  blocks.push({
    type: 'actions',
    elements: [{ type: 'button', text: plain(L.openInFigma, 75), url: main ? main.frame.url : update.fileUrl }],
  });
  const more = moreText(update, threads);
  if (more) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: esc(more) }] });
  return { main: blocks, replies: threads ? rest.map((p) => pairBlocks(p, L, true, images)) : [] };
}

const isImageError = (msg) => /invalid_blocks|downloading image|image_url/i.test(msg || '');

export default {
  name: 'slack',
  title: 'Slack',
  isConfigured: (env) => Boolean((env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) || env.SLACK_WEBHOOK_URL),

  mode(env, cfg) {
    const bot = Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID);
    return { bot, threads: bot && cfg?.channels?.slack?.threads !== false };
  },

  preview(update, { env = {}, cfg } = {}) {
    // Without secrets (local dry run), preview bot mode.
    const bot = Boolean(env.SLACK_BOT_TOKEN && env.SLACK_CHANNEL_ID) || !env.SLACK_WEBHOOK_URL;
    const threads = bot && cfg?.channels?.slack?.threads !== false;
    const b = buildBlocks(update, { threads });
    return [
      { to: threads ? 'Slack chat.postMessage (main)' : 'Slack (single message, no thread)', body: { text: update.title, blocks: b.main } },
      ...b.replies.map((blocks) => ({ to: 'Slack chat.postMessage (thread reply, thread_ts = main ts)', body: { text: update.title, blocks } })),
    ];
  },

  async send(update, { env, cfg, log = () => {} }) {
    const { bot, threads } = this.mode(env, cfg);
    const post = async (blocks, threadTs, label) => {
      if (bot) {
        const data = await requestJson(
          'https://slack.com/api/chat.postMessage',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` },
            body: JSON.stringify({
              channel: env.SLACK_CHANNEL_ID,
              text: update.title,
              blocks,
              unfurl_links: false,
              unfurl_media: false,
              ...(threadTs ? { thread_ts: threadTs } : {}),
            }),
          },
          { label: `Slack ${label}`, tries: 4, log },
        );
        if (!data.ok) {
          const err = new Error(`Slack ${label}: ${data.error}${data.errors ? ' ' + JSON.stringify(data.errors) : ''}`);
          err.slackError = data.error + ' ' + JSON.stringify(data.errors || '');
          throw err;
        }
        return data.ts;
      }
      await request(
        env.SLACK_WEBHOOK_URL,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: update.title, blocks }) },
        { label: `Slack webhook ${label}`, tries: 4, log },
      );
      return null;
    };

    // If Slack can't fetch a picture it rejects the whole message; resend with picture links instead.
    const postWithFallback = async (makeBlocks, threadTs, label) => {
      try {
        return await post(makeBlocks(true), threadTs, label);
      } catch (e) {
        if (!isImageError(e.slackError || e.message)) throw e;
        log(`  Slack could not load a picture (${label}); sending picture links instead`);
        return post(makeBlocks(false), threadTs, label);
      }
    };

    const ts = await postWithFallback((images) => buildBlocks(update, { threads, images }).main, null, 'main message');
    const replyCount = threads ? update.pairs.length - 1 : 0;
    for (let i = 0; i < replyCount; i++) {
      await sleep(1100);
      await postWithFallback((images) => buildBlocks(update, { threads, images }).replies[i], ts, `thread reply ${i + 1}`);
    }
    return 1 + replyCount;
  },
};
