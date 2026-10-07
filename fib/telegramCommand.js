/**
 * Telegram-only /goldenpocket command.
 *
 * Attaches the Golden Pocket fib workflow to a token that is already tracked
 * by the Telegram Take Profits bot and returns a signed editor link.
 */
import { FIB } from './config.js';
import { ensureDBSchema, loadDB } from '../dbStore.js';
import { resolveUserInputToKey } from '../chains.js';
import { updateFibWatch } from './store.js';
import { buildGoldenPocketSetupUrl } from './editorWeb.js';
import { sendTelegramMessage, isChatAdmin } from '../notifier.js';

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export async function handleTgGoldenPocket(chatId, userId, args = []) {
  if (!FIB.ENABLED) {
    await sendTelegramMessage(chatId, { text: 'Golden Pocket tracking is currently disabled.' });
    return;
  }

  const admin = await isChatAdmin(chatId, userId);
  if (!admin) {
    await sendTelegramMessage(chatId, { text: 'Admins only.' });
    return;
  }

  const raw = String(args[0] || '').trim();
  if (!raw) {
    await sendTelegramMessage(chatId, {
      text:
        '<b>Usage:</b> <code>/goldenpocket &lt;contract address&gt;</code>\n' +
        'The token must already be tracked in this Telegram bot.',
    });
    return;
  }

  const db = ensureDBSchema(loadDB());
  const key = resolveUserInputToKey(db, raw);
  const entry = key ? db.tokens?.[key] : null;
  if (!key || !entry) {
    await sendTelegramMessage(chatId, {
      text:
        'That token is not tracked yet. Post the contract address first, then run ' +
        '<code>/goldenpocket ' + esc(raw) + '</code>.',
    });
    return;
  }

  const now = Date.now();
  updateFibWatch((fw) => {
    const cur = fw[key] || {
      chain: entry.chain,
      address: entry.address,
      symbol: entry.symbol,
      rev: 0,
    };
    cur.goldenPocketEnabled = true;
    cur.recalcAt = now;
    cur.timeframe = cur.timeframe || FIB.DEFAULT_TIMEFRAME;
    cur.mode = 'standard';
    delete cur.suppress;
    cur.rev = (cur.rev || 0) + 1;
    fw[key] = cur;
  });

  const url = buildGoldenPocketSetupUrl(key);
  const symbol = esc(entry.symbol || key.slice(0, 10));
  const linkLine = url
    ? '\n\n<a href="' + url + '">Open Golden Pocket Fib Editor</a>'
    : '\n\nEditor link unavailable — check FIB_EDITOR_BASE_URL / FIB_EDITOR_SECRET.';

  await sendTelegramMessage(chatId, {
    text:
      '<b>Golden Pocket attached: ' + symbol + '</b>\n' +
      'Fresh auto Fib detection is queued. You can also open the editor and pull the Fib manually.' +
      '\nPre-buy: 2 consecutive 5m closes inside 0.382 → 0.236.' +
      '\nSize-in: immediate live touch/cross of 0.236.' +
      linkLine,
  });
}
