/** Telegram platform entry — long-poll + auto-track + /calls + /remove. */
import 'dotenv/config';
import { initAlertGate } from './alertGate.js';
import { runVolumeBackup } from './scripts/backup-volume.mjs';
import { DATA_DIR, loadDB, saveDB, ensureDBSchema, markRemovedThisCycle } from './dbStore.js';
import { extractAddresses, resolveUserInputToKey, parseEnabledChains, chainLabel } from './chains.js';
import { pollTokens } from './poller.js';
import { autoTrack } from './tracker.js';
import { renderEmbedForTelegram, sendTelegramMessage, isChatAdmin } from './notifier.js';
import { buildCallsEmbed } from './callsView.js';
import { startHttpServer } from './httpServer.js';

/** Mirror index.js runTokenPollLoop cadence. */
const TOKEN_POLL_INTERVAL_MS = 3 * 60 * 1000;
const TOKEN_POLL_MIN_GAP_MS = 5000;

const tgClient = {};

function botBaseUrl() {
  return 'https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN;
}

async function tgApi(method, params = {}) {
  const url = botBaseUrl() + '/' + method;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(method + ' failed: ' + (data.description || res.status));
  }
  return data.result;
}

function buildMessageShim(msg) {
  const chatId = String(msg.chat.id);
  return {
    content: msg.text || '',
    author: {
      bot: Boolean(msg.from?.is_bot),
      username: msg.from?.username || msg.from?.first_name || 'unknown',
      id: String(msg.from?.id),
    },
    guildId: chatId,
    channelId: chatId,
    channel: {
      send: ({ embeds, files }) => {
        const payload = renderEmbedForTelegram(embeds[0]);
        if (files && files.length && files[0]?.attachment) {
          payload.photoBuffer = files[0].attachment;
          payload.photoName = files[0].name || 'chart.png';
        }
        return sendTelegramMessage(chatId, payload);
      },
    },
    client: tgClient,
  };
}

function parseCommand(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [rawCmd, ...rest] = trimmed.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  return { cmd, args: rest };
}

async function handleCallsCommand(chatId) {
  const embed = buildCallsEmbed();
  if (!embed) {
    await sendTelegramMessage(chatId, {
      text: 'Nothing tracked yet — drop a contract address in chat.',
    });
    return;
  }
  const payload = renderEmbedForTelegram(embed);
  await sendTelegramMessage(chatId, payload);
}

async function handleRemoveCommand(chatId, userId, args) {
  const admin = await isChatAdmin(chatId, userId);
  if (!admin) {
    await sendTelegramMessage(chatId, { text: 'Admins only.' });
    return;
  }
  const address = (args[0] || '').trim();
  if (!address) {
    await sendTelegramMessage(chatId, { text: 'Usage: /remove &lt;ca&gt;' });
    return;
  }
  const db = ensureDBSchema(loadDB());
  const key = resolveUserInputToKey(db, address);
  if (!key) {
    await sendTelegramMessage(chatId, {
      text: 'Not tracking <code>' + address.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code>',
    });
    return;
  }
  const name = db.tokens[key].name;
  const symbol = db.tokens[key].symbol;
  delete db.tokens[key];
  markRemovedThisCycle(key);
  saveDB(db);
  await sendTelegramMessage(chatId, {
    text:
      'Stopped tracking <b>' +
      String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      ' (' +
      String(symbol).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      ')</b> · <code>' +
      String(key).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
      '</code>',
  });
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const parsed = parseCommand(msg.text);
  if (parsed) {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || '');
    if (parsed.cmd === '/calls') {
      await handleCallsCommand(chatId);
      return;
    }
    if (parsed.cmd === '/remove') {
      await handleRemoveCommand(chatId, userId, parsed.args);
      return;
    }
    return;
  }

  const shim = buildMessageShim(msg);
  if (shim.author.bot) return;
  const refs = extractAddresses(shim.content);
  if (refs.length === 0) return;
  const seen = new Set();
  for (const ref of refs) {
    await autoTrack(ref, shim, seen).catch((e) =>
      console.error('[autotrack] Error for ' + ref.raw + ':', e.message));
  }
}

async function fastForwardOffset() {
  try {
    const result = await tgApi('getUpdates', { offset: -1, limit: 1 });
    if (Array.isArray(result) && result.length > 0) {
      return result[0].update_id + 1;
    }
  } catch (e) {
    console.error('[tg] backlog fast-forward failed:', e.message);
  }
  return 0;
}

async function longPollLoop(startOffset) {
  let offset = startOffset;
  while (true) {
    try {
      const updates = await tgApi('getUpdates', {
        timeout: 30,
        allowed_updates: ['message'],
        offset,
      });
      for (const update of updates || []) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (e) {
          console.error('[tg] update handler error:', e.message);
        }
      }
    } catch (e) {
      console.error('[tg] getUpdates error:', e.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function runTokenPollLoop(client) {
  while (true) {
    const t0 = Date.now();
    try {
      await pollTokens(client);
    } catch (e) {
      console.error('[poll] loop error:', e);
    }
    const elapsed = Date.now() - t0;
    const wait = Math.max(TOKEN_POLL_MIN_GAP_MS, TOKEN_POLL_INTERVAL_MS - elapsed);
    console.log('[poll] cycle ' + Math.round(elapsed / 1000) + 's — next in ' + Math.round(wait / 1000) + 's');
    await new Promise((r) => setTimeout(r, wait));
  }
}

async function registerCommands() {
  await tgApi('setMyCommands', {
    commands: [
      { command: 'calls', description: 'Show all tracked tokens and their current performance' },
      { command: 'remove', description: 'Stop tracking a token (admins only)' },
    ],
  });
  console.log('[tg] commands registered: /calls /remove');
}

async function boot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.error('[boot] TELEGRAM_BOT_TOKEN missing — cannot start Telegram platform');
    process.exit(1);
  }

  console.log('[boot] PLATFORM=telegram');
  console.log('[boot] Using data dir: ' + DATA_DIR);
  console.log('Data directory: ' + DATA_DIR);
  console.log('[boot] Enabled chains: ' + parseEnabledChains().map(chainLabel).join(' · '));

  try {
    initAlertGate();
  } catch (e) {
    console.error('[boot] initAlertGate failed:', e.message);
  }

  runVolumeBackup();

  try {
    await registerCommands();
  } catch (e) {
    console.error('[boot] setMyCommands failed:', e.message);
  }

  // httpServer only needs client for webhook/devsell paths; /health is fine with a stub.
  startHttpServer(tgClient, () => ensureDBSchema(loadDB()));

  const offset = await fastForwardOffset();
  console.log('[tg] long-poll starting at offset ' + offset);
  void longPollLoop(offset);
  void runTokenPollLoop(tgClient);
}

boot().catch((e) => {
  console.error('[boot] fatal:', e);
  process.exit(1);
});
