/**
 * mintscan/mintParse.js — pure log-decoding + tiering. No I/O, fully testable.
 *
 * Ported verbatim in behaviour from take_profi_bot/src/mint-scanner/monitor.ts,
 * split out so the parsing rules can be unit-tested without touching an RPC.
 *
 * A "mint" is a Transfer/TransferSingle/TransferBatch whose `from` is the zero
 * address. ERC-20 Transfer shares topic0 with ERC-721, so ERC-721 is
 * distinguished by having 4 topics (from, to, tokenId) vs ERC-20's 3.
 */

export const ZERO = '0x0000000000000000000000000000000000000000';
export const ZERO_TOPIC = '0x0000000000000000000000000000000000000000000000000000000000000000';

export const TOPIC_ERC721_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOPIC_ERC1155_SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
export const TOPIC_ERC1155_BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';

/** Cap per log so a bad parse can't blow up memory. */
export const MAX_QTY_PER_EVENT = 500;

export function safeQty(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(Math.floor(raw), MAX_QTY_PER_EVENT);
}

function padTopicAddr(topic) {
  const hex = String(topic || '').toLowerCase().replace(/^0x/, '');
  return '0x' + hex.slice(Math.max(0, hex.length - 40));
}

function readUint256(data, offsetBytes) {
  const hex = String(data || '').replace(/^0x/, '');
  const chunk = hex.slice(offsetBytes * 2, offsetBytes * 2 + 64);
  if (!chunk) return 0n;
  return BigInt('0x' + chunk);
}

export function parse1155BatchTotal(data) {
  try {
    const valuesOffset = Number(readUint256(data, 32));
    if (!Number.isFinite(valuesOffset) || valuesOffset < 0 || valuesOffset > 10_000) return 1;
    const len = Number(readUint256(data, valuesOffset));
    if (!Number.isFinite(len) || len <= 0) return 1;
    const cappedLen = Math.min(len, 256);
    let sum = 0n;
    for (let i = 0; i < cappedLen; i++) sum += readUint256(data, valuesOffset + 32 + i * 32);
    const total = Number(sum);
    // Truncated / malformed calldata can sum to 0 — treat as a single mint
    // rather than silently dropping the event from the count.
    if (!Number.isFinite(total) || total <= 0) return 1;
    return Math.min(total, MAX_QTY_PER_EVENT);
  } catch {
    return 1;
  }
}

/** logs → [{ contract, minter, qty, tx, block }] (mints only). */
export function parseMintEvents(logs) {
  const out = [];
  for (const l of logs || []) {
    const topic0 = (l.topics?.[0] || '').toLowerCase();

    if (topic0 === TOPIC_ERC721_TRANSFER) {
      if (!l.topics || l.topics.length !== 4) continue; // ERC-20 has 3 — skip
      if (padTopicAddr(l.topics[1]) !== ZERO) continue;
      out.push({
        contract: l.address.toLowerCase(),
        minter: padTopicAddr(l.topics[2]),
        qty: 1,
        tx: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
      });
    } else if (topic0 === TOPIC_ERC1155_SINGLE) {
      if (padTopicAddr(l.topics?.[2]) !== ZERO) continue;
      out.push({
        contract: l.address.toLowerCase(),
        minter: padTopicAddr(l.topics[3]),
        qty: safeQty(Number(readUint256(l.data, 32))),
        tx: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
      });
    } else if (topic0 === TOPIC_ERC1155_BATCH) {
      if (padTopicAddr(l.topics?.[2]) !== ZERO) continue;
      out.push({
        contract: l.address.toLowerCase(),
        minter: padTopicAddr(l.topics[3]),
        qty: safeQty(parse1155BatchTotal(l.data)),
        tx: l.transactionHash,
        block: parseInt(l.blockNumber, 16),
      });
    }
  }
  return out;
}

/** Heat tier from the rolling window, or null if it doesn't qualify. */
export function tierFor(mints, unique, cfg) {
  if (unique < cfg.minUnique) return null;
  if (mints >= cfg.moonMints) return 'MOONING';
  if (mints >= cfg.hotMints) return 'HOT';
  if (mints >= cfg.warmMints) return 'WARM';
  return null;
}

export function windowMintCount(w) {
  return w.chunks.reduce((sum, c) => sum + c.qty, 0);
}

export function pruneWindow(w, minBlock) {
  w.chunks = w.chunks.filter((c) => c.block >= minBlock);
  for (const [addr, lastBlock] of Object.entries(w.minters)) {
    if (lastBlock < minBlock) delete w.minters[addr];
  }
}
