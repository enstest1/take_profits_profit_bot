/**
 * nfttp/index.js — NFT take-profits wiring.
 *
 * Same cards as token TP (+75% then 1x–20x) against OpenSea floor.
 * startNftTp(client) no-ops unless NFT_TP_ENABLED=true and OPENSEA_API_KEY is set.
 */

import { getNftTpConfig, isNftTpEnabled } from './config.js';
import { hasOpenSeaKey } from './opensea.js';
import { startNftTpPoller } from './poller.js';
import { handleNftMessage } from './autotrack.js';

export { isNftTpEnabled, getNftTpConfig } from './config.js';
export { handleNftMessage } from './autotrack.js';
export {
  nfttrackCommand,
  nftcallsCommand,
  nftremoveCommand,
  handleNfttrack,
  handleNftcalls,
  handleNftremove,
} from './commands.js';

export function startNftTp(client) {
  const cfg = getNftTpConfig();
  if (!cfg.enabled) {
    console.log('[nfttp] disabled (NFT_TP_ENABLED not true)');
    return;
  }
  if (!hasOpenSeaKey()) {
    console.error('[nfttp] OPENSEA_API_KEY missing — refusing to start');
    return;
  }
  const ch = cfg.channelIds.length ? cfg.channelIds.join(',') : 'all channels';
  console.log(
    '[nfttp] enabled · auto-track OpenSea URLs in ' + ch +
      (cfg.trackContracts ? ' · 0x contracts ON' : ' · URLs/slugs only'),
  );
  startNftTpPoller(client);
}

export { handleNftMessage as onNftMessage };
