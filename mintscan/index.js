/**
 * mintscan/index.js — wiring entry point.
 *
 * startMintScan(client) boots the scanner only when MINT_SCANNER_ENABLED=true.
 * With the flag off nothing runs, no RPC is touched, and the bot behaves
 * exactly as before.
 *
 * Posting goes through the Discord client directly (not sendChannelAlert)
 * because mint cards EDIT in place as a collection heats up, and editing needs
 * the message handle. Telegram is not wired for this feature — the edit model
 * has no clean Telegram equivalent yet.
 */

import { getMintScannerConfig } from './config.js';
import { startMintScanner } from './monitor.js';
import { buildMintCard } from './card.js';

export async function startMintScan(client) {
  const cfg = getMintScannerConfig();

  if (!cfg.enabled) {
    console.log('[mintscan] disabled (MINT_SCANNER_ENABLED not true)');
    return;
  }
  if (!cfg.channelId) {
    console.error('[mintscan] MINT_SCANNER_CHANNEL_ID not set — refusing to start');
    return;
  }
  if (!process.env.OPENSEA_API_KEY?.trim()) {
    console.warn(
      '[mintscan] no OPENSEA_API_KEY — floors/slugs unavailable and the OpenSea spam ' +
        'filter is OFF. Expect noisy alerts until a key is set.',
    );
  }

  const send = async (alert, existing) => {
    const embed = buildMintCard(alert, cfg.chain);
    const channel = await client.channels.fetch(cfg.channelId);

    // Escalating tier → edit the existing card so one collection = one message.
    if (existing?.messageId) {
      try {
        const msg = await channel.messages.fetch(existing.messageId);
        await msg.edit({ embeds: [embed] });
        return existing.messageId;
      } catch {
        // Message deleted or too old — fall through and post a fresh one.
      }
    }
    const sent = await channel.send({ embeds: [embed] });
    return sent.id;
  };

  startMintScanner(send);
}
