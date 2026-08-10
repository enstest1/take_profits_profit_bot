/** Telegram rendering + sending — no third-party Telegram SDK. */

const TG_MIN_GAP_MS = 3000;
const lastSentAtByChat = new Map();

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Escape first, then convert Discord-ish markdown to Telegram HTML. */
function discordMdToTelegramHtml(raw) {
  let s = escapeHtml(raw);
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*([^*]+)\*/g, '<i>$1</i>');
  s = s.replace(/_([^_]+)_/g, '<i>$1</i>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

export function truncateTelegramText(text, max = 4096) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/**
 * @param {import('discord.js').EmbedBuilder | { data?: object }} embed
 * @returns {{ text: string, photoUrl: string|null }}
 */
export function renderEmbedForTelegram(embed) {
  const data = embed?.data || embed || {};
  const title = data.title || data.author?.name || '';
  const parts = [];

  if (title) parts.push('<b>' + discordMdToTelegramHtml(title) + '</b>');
  if (data.description) {
    if (parts.length) parts.push('');
    parts.push(discordMdToTelegramHtml(data.description));
  }
  if (Array.isArray(data.fields)) {
    for (const field of data.fields) {
      if (!field) continue;
      const name = discordMdToTelegramHtml(field.name || '');
      const value = discordMdToTelegramHtml(field.value || '');
      parts.push('<b>' + name + '</b>: ' + value);
    }
  }
  if (data.footer?.text) {
    parts.push('<i>' + discordMdToTelegramHtml(data.footer.text) + '</i>');
  }

  // Telegram: use full embed image only (e.g. charts); the token thumbnail/logo is
  // intentionally omitted on Telegram per group preference. Discord keeps its thumbnail.
  const rawUrl = data.image?.url ?? null;
  const photoUrl = rawUrl && String(rawUrl).startsWith('http') ? String(rawUrl) : null;

  return { text: parts.join('\n'), photoUrl };
}

function botBaseUrl() {
  return 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function paceChat(chatId) {
  const key = String(chatId);
  const last = lastSentAtByChat.get(key) || 0;
  const wait = TG_MIN_GAP_MS - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  lastSentAtByChat.set(key, Date.now());
}

async function tgFetch(method, body, { formData = null } = {}) {
  const url = botBaseUrl() + '/' + method;
  const init = formData
    ? { method: 'POST', body: formData }
    : {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
  let res = await fetch(url, init);
  if (res.status === 429) {
    let retryAfter = 1;
    try {
      const j = await res.json();
      retryAfter = Number(j?.parameters?.retry_after) || 1;
    } catch {
      /* ignore */
    }
    await sleep(retryAfter * 1000);
    res = await fetch(url, init);
  }
  return res;
}

/**
 * @param {string|number} chatId
 * @param {{ text: string, photoUrl?: string|null, photoBuffer?: Buffer|Uint8Array|null, photoName?: string }} payload
 * @returns {Promise<boolean>}
 */
export async function sendTelegramMessage(
  chatId,
  { text, photoUrl = null, photoBuffer = null, photoName = 'chart.png' },
) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      console.error('[tg] TELEGRAM_BOT_TOKEN missing');
      return false;
    }
    await paceChat(chatId);
    const fullText = truncateTelegramText(text || '', 4096);

    if (photoBuffer) {
      const fd = new FormData();
      fd.append('chat_id', String(chatId));
      fd.append('photo', new Blob([photoBuffer], { type: 'image/png' }), photoName || 'chart.png');
      if (fullText.length <= 1024) {
        fd.append('caption', fullText);
        fd.append('parse_mode', 'HTML');
        const res = await tgFetch('sendPhoto', null, { formData: fd });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          console.error('[tg] sendPhoto failed:', res.status, body.slice(0, 200));
          return false;
        }
        return true;
      }
      const firstLine = fullText.split('\n')[0] || '';
      fd.append('caption', truncateTelegramText(firstLine, 1024));
      fd.append('parse_mode', 'HTML');
      const res = await tgFetch('sendPhoto', null, { formData: fd });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[tg] sendPhoto failed:', res.status, body.slice(0, 200));
        return false;
      }
      await paceChat(chatId);
      const res2 = await tgFetch('sendMessage', {
        chat_id: chatId,
        text: fullText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
      if (!res2.ok) {
        const body = await res2.text().catch(() => '');
        console.error('[tg] sendMessage follow-up failed:', res2.status, body.slice(0, 200));
        return false;
      }
      return true;
    }

    if (photoUrl && fullText.length <= 1024) {
      const res = await tgFetch('sendPhoto', {
        chat_id: chatId,
        photo: photoUrl,
        caption: fullText,
        parse_mode: 'HTML',
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        console.error('[tg] sendPhoto(url) failed:', res.status, body.slice(0, 200));
        return false;
      }
      return true;
    }

    const res = await tgFetch('sendMessage', {
      chat_id: chatId,
      text: fullText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[tg] sendMessage failed:', res.status, body.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[tg] send failed:', e.message);
    return false;
  }
}

/** @returns {Promise<boolean>} */
export async function isChatAdmin(chatId, userId) {
  try {
    if (!process.env.TELEGRAM_BOT_TOKEN) return false;
    const url =
      botBaseUrl() +
      '/getChatMember?chat_id=' +
      encodeURIComponent(String(chatId)) +
      '&user_id=' +
      encodeURIComponent(String(userId));
    const res = await fetch(url);
    if (!res.ok) return false;
    const data = await res.json();
    const status = data?.result?.status;
    return status === 'creator' || status === 'administrator';
  } catch (e) {
    console.error('[tg] getChatMember failed:', e.message);
    return false;
  }
}
