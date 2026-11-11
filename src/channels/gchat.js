// Google Chat (Google Workspace): incoming webhook + cardsV2.
// Main card in a new thread (threadKey = changelog-<versionId>), one reply card per extra frame.
import { requestJson, sleep } from '../http.js';
import { escapeHtml as h, pictureLabel, moreText, fitLines } from './common.js';
import { groupTitle } from '../describe.js';

const IND = '&nbsp;&nbsp;&nbsp;&nbsp;';

function summaryHtml(update) {
  const lines = [];
  for (const page of update.pages) {
    lines.push(`<b>${h(page.name)}</b>`);
    for (const g of page.groups) {
      lines.push(`• ${groupTitle(g, (f) => `<a href="${h(f.url)}">${h(f.name)}</a>`)}`);
      for (const l of g.lines) {
        const [first, ...rest] = l.split('\n');
        lines.push(`${IND}– ${h(first)}`, ...rest.map((r) => `${IND}${IND}${h(r)}`));
      }
      if (g.hiddenLines) lines.push(`${IND}– …and ${g.hiddenLines} more`);
    }
  }
  return fitLines(lines, 3800, '<br>').join('<br>');
}

function pictureColumn(pair, which, labels) {
  const pic = pair[which];
  return {
    horizontalSizeStyle: 'FILL_AVAILABLE_SPACE',
    horizontalAlignment: 'CENTER',
    verticalAlignment: 'TOP',
    widgets: [
      { textParagraph: { text: `<b>${h(pictureLabel(pair, which, labels))}</b>` } },
      { image: { imageUrl: pic.url, altText: `${pair.frame.name} – ${pictureLabel(pair, which, labels)}` } },
    ],
  };
}

function pairWidgets(pair, labels, withTitle) {
  const widgets = [];
  if (withTitle) {
    widgets.push({
      textParagraph: { text: `<a href="${h(pair.frame.url)}"><b>${h(pair.frame.name)}</b></a> · ${h(pair.frame.page)}` },
    });
  }
  const cols = ['before', 'after'].filter((w) => pair[w]?.url).map((w) => pictureColumn(pair, w, labels));
  if (cols.length === 2) widgets.push({ columns: { columnItems: cols } });
  else if (cols.length === 1) widgets.push(...cols[0].widgets);
  return widgets;
}

export function buildMessages(update) {
  const L = update.labels;
  const [main, ...rest] = update.pairs;
  const sections = [];
  const note = [update.version.label, update.version.description].filter(Boolean).join(' — ');
  if (note) sections.push({ widgets: [{ textParagraph: { text: `<i>${h(note)}</i>` } }] });
  sections.push({ widgets: [{ textParagraph: { text: summaryHtml(update) } }] });
  if (main) sections.push({ header: h(`${main.frame.name} · ${main.frame.page}`), widgets: pairWidgets(main, L, false) });
  const footer = [];
  const more = moreText(update);
  if (more) footer.push({ textParagraph: { text: `<i>${h(more)}</i>` } });
  footer.push({
    buttonList: { buttons: [{ text: L.openInFigma, onClick: { openLink: { url: main ? main.frame.url : update.fileUrl } } }] },
  });
  sections.push({ widgets: footer });

  const card = (id, s, header) => ({ cardsV2: [{ cardId: id, card: { ...(header ? { header } : {}), sections: s } }] });
  const messages = [{ kind: 'main', body: card(`changelog-${update.version.id}`, sections, { title: update.title }) }];
  rest.forEach((pair, i) => {
    messages.push({ kind: 'reply', body: card(`changelog-${update.version.id}-${i + 1}`, [{ widgets: pairWidgets(pair, L, true) }]) });
  });
  return messages;
}

export default {
  name: 'gchat',
  title: 'Google Chat',
  isConfigured: (env) => Boolean(env.GCHAT_WEBHOOK_URL),

  preview(update) {
    return buildMessages(update).map((m) => ({
      to: `Google Chat webhook (${m.kind})`,
      query: { threadKey: `changelog-${update.version.id}`, messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' },
      body: m.body,
    }));
  },

  async send(update, { env, log = () => {}, testRunId }) {
    const url = new URL(env.GCHAT_WEBHOOK_URL);
    // Test posts get their own thread, so a second test never lands inside the first one.
    url.searchParams.set('threadKey', `changelog-${update.version.id}${testRunId ? `-test-${testRunId}` : ''}`);
    url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    const messages = buildMessages(update);
    for (const [i, m] of messages.entries()) {
      if (i) await sleep(1100); // webhooks allow ~1 message per second per space
      await requestJson(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(m.body) },
        { label: `Google Chat ${m.kind} message`, tries: 4, log },
      );
    }
    return messages.length;
  },
};
