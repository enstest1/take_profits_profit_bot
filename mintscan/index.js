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
 *
 * MINT_SCANNER_CHANNEL_IDS (comma list) posts the same card to every channel;
 * tier escalations edit each channel's message in place.
 */

import { getMintScannerConfig } from './config.js';
import { startMintScanner } from './monitor.js';
import { buildMintCard } from './card.js';
import { isBlockedChannel } from '../blockedChannels.js';
import { isCaMutedChannel } from '../caMuteChannels.js';

export async function startMintScan(client) {
  const cfg = getMintScannerConfig();

  if (!cfg.enabled) {
    console.log('[mintscan] disabled (MINT_SCANNER_ENABLED not true)');
    return;
  }
  if (!cfg.channelIds.length) {
    console.error('[mintscan] MINT_SCANNER_CHANNEL_ID(S) not set — refusing to start');
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
    const messageIds = { ...(existing?.messageIds || {}) };

    // Legacy single-channel card shape — migrate on first edit.
    if (existing?.messageId && existing?.channelId && !messageIds[existing.channelId]) {
      messageIds[existing.channelId] = existing.messageId;
    }

    for (const channelId of cfg.channelIds) {
      // #nft-land is NFT volume-bot only — drop cards stay on the personal mirror.
      if (isBlockedChannel(channelId) || isCaMutedChannel(channelId)) continue;
      const channel = await client.channels.fetch(channelId);
      const prevId = messageIds[channelId] || null;

      // Escalating tier → edit the existing card so one collection = one message per channel.
      if (prevId && existing?.tier) {
        try {
          const msg = await channel.messages.fetch(prevId);
          await msg.edit({ embeds: [embed] });
          messageIds[channelId] = prevId;
          continue;
        } catch {
          // Message deleted or too old — fall through and post a fresh one.
        }
      }

      const sent = await channel.send({ embeds: [embed] });
      messageIds[channelId] = sent.id;
    }

    return messageIds;
  };

  startMintScanner(send);
}
