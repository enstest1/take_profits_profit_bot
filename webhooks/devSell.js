/** Helius dev-sell webhook handler — env-gated, async processing. */
import { EmbedBuilder } from 'discord.js';
import { rateLimiter } from '../rateLimiter.js';
import { sendTokenAlert } from '../channelAlert.js';
import { saveDB } from '../dbStore.js';

const DEV_SELL_COOLDOWN_MS = 30 * 60 * 1000;
const MIN_SELL_USD = 100;
const MAX_HELIUS_ADDRS = 90;

export function isDevSellEnabled() {
  return !!(process.env.HELIUS_API_KEY && process.env.WEBHOOK_PUBLIC_URL && process.env.WEBHOOK_SECRET);
}

export function ensureMetaDb(db) {
  db.meta = db.meta || {};
  db.meta.heliusAddresses = db.meta.heliusAddresses || [];
  return db.meta;
}

export async function subscribeDevWallet(db, mint, devWallet) {
  if (!isDevSellEnabled() || !devWallet || !mint) return;
  const meta = ensureMetaDb(db);
  if (meta.heliusAddresses.includes(devWallet)) return;
  if (meta.heliusAddresses.length >= MAX_HELIUS_ADDRS) {
    console.warn('[devsell] address cap reached — skip subscribe ' + devWallet.slice(0, 8));
    return;
  }
  meta.heliusAddresses.push(devWallet);
  await syncHeliusWebhook(db);
}

export async function unsubscribeDevWallet(db, devWallet) {
  if (!devWallet) return;
  const meta = ensureMetaDb(db);
  meta.heliusAddresses = meta.heliusAddresses.filter((a) => a !== devWallet);
  await syncHeliusWebhook(db);
}

async function syncHeliusWebhook(db) {
  const meta = ensureMetaDb(db);
  const addrs = meta.heliusAddresses || [];
  const apiKey = process.env.HELIUS_API_KEY;
  const webhookUrl = process.env.WEBHOOK_PUBLIC_URL + '/helius-webhook';
  const authHeader = process.env.WEBHOOK_SECRET;

  try {
    if (!meta.heliusWebhookId && addrs.length > 0) {
      const res = await rateLimiter.fetch(
        'https://api.helius.xyz/v0/webhooks?api-key=' + encodeURIComponent(apiKey),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhookURL: webhookUrl,
            transactionTypes: ['SWAP', 'TRANSFER'],
            accountAddresses: addrs,
            webhookType: 'enhanced',
            authHeader,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (res.ok) {
        const data = await res.json();
        meta.heliusWebhookId = data.webhookID || data.webhookId;
        saveDB(db);
      }
      return;
    }
    if (meta.heliusWebhookId) {
      await rateLimiter.fetch(
        'https://api.helius.xyz/v0/webhooks/' + meta.heliusWebhookId + '?api-key=' + encodeURIComponent(apiKey),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            webhookURL: webhookUrl,
            transactionTypes: ['SWAP', 'TRANSFER'],
            accountAddresses: addrs,
            webhookType: 'enhanced',
            authHeader,
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );
      saveDB(db);
    }
  } catch (e) {
    console.error('[devsell] webhook sync:', e.message);
  }
}

export async function processHeliusPayload(client, db, payload) {
  const events = Array.isArray(payload) ? payload : [payload];
  for (const tx of events) {
    try {
      await processOneTx(client, db, tx);
    } catch (e) {
      console.error('[devsell] tx process:', e.message);
    }
  }
}

async function processOneTx(client, db, tx) {
  const ts = tx.timestamp ? Number(tx.timestamp) * 1000 : Date.now();
  const transfers = tx.tokenTransfers || [];
  for (const [mint, entry] of Object.entries(db.tokens || {})) {
    if (!entry.devWallet || entry.chain === 'robinhood') continue;
    if (ts - (entry.devSellAlertAt || 0) < DEV_SELL_COOLDOWN_MS) continue;

    const dev = entry.devWallet;
    const sell = transfers.find((t) => {
      if (t.mint !== mint && t.mint !== entry.address) return false;
      return t.fromUserAccount === dev || t.from === dev;
    });
    if (!sell) continue;

    const usd = Number(sell.tokenAmount || sell.amount || 0) * Number(entry.lastPrice || 0);
    if (usd < MIN_SELL_USD && usd > 0) continue;

    const mult =
      entry.lastPrice && entry.priceAtCall
        ? Number(entry.lastPrice) / Number(entry.priceAtCall)
        : null;
    const agoSec = Math.round((Date.now() - ts) / 1000);

    const embed = new EmbedBuilder()
      .setColor(0xff3333)
      .setTitle('🚨 DEV SELLING — ' + entry.name + ' (' + entry.symbol + ')')
      .setDescription(
        'Dev wallet moved ~$' + (usd > 0 ? usd.toFixed(0) : '?') + ' of supply ' + agoSec + 's ago\n' +
        'Token at ' + (mult != null ? mult.toFixed(1) + 'x' : '—') + ' from call · Liq —',
      )
      .setTimestamp();

    const sent = await sendTokenAlert(client, db, mint, embed, 'devsell', 'devsell');
    if (sent) {
      entry.devSellAlertAt = Date.now();
      saveDB(db);
    }
  }
}

export async function onTokenDeadOrArchived(db, entry) {
  if (entry?.devWallet) await unsubscribeDevWallet(db, entry.devWallet);
}
