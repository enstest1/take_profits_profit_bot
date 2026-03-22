"use strict";

/**
 * walletWatcher.js — wallet watchlist polling
 * Runs every 5 minutes, alerts when a watched wallet buys a new token.
 */

const { getWalletRecentTrades } = require("./moralis.js");

/**
 * Determine explorer URL for a transaction.
 * Uses Solscan for Solana (base58 wallet), Etherscan otherwise.
 */
function explorerUrl(walletAddress, txHash) {
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress) &&
    !walletAddress.startsWith("0x");
  if (isSolana) return `https://solscan.io/tx/${txHash}`;
  return `https://etherscan.io/tx/${txHash}`;
}

function fmtWallet(addr) {
  if (!addr) return "unknown";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/**
 * Build embed for a wallet buy alert.
 */
function buildWalletBuyEmbed(watchEntry, trade) {
  const label = watchEntry.label || fmtWallet(watchEntry.address);
  const tokenSym = trade.tokenOut?.symbol ?? trade.tokenIn?.symbol ?? "???";
  const tokenName = trade.tokenOut?.name ?? trade.tokenIn?.name ?? "Unknown";
  const amount = trade.tokenOut?.amount ?? "?";
  const usdValue = trade.usdValue ?? trade.tokenOut?.usdValue ?? null;
  const txHash = trade.transactionHash ?? trade.signature ?? "";
  const url = explorerUrl(watchEntry.address, txHash);

  return {
    color: 0x9b59b6,
    title: `👁️ Wallet Activity — ${label}`,
    description: [
      `Watched wallet **${label}** just bought **${tokenSym}**`,
      "",
      `Token: ${tokenName} (${tokenSym})`,
      `Amount: ${amount}`,
      usdValue != null ? `Value: ~$${Number(usdValue).toFixed(2)}` : "",
      `Wallet: ${fmtWallet(watchEntry.address)}`,
      "",
      `[View on Solscan / Etherscan](${url})`,
    ]
      .filter(Boolean)
      .join("\n"),
    footer: { text: `Added by ${watchEntry.addedBy}` },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Main polling function — call on startup and every 5 minutes.
 * @param {import('discord.js').Client} client
 * @param {object} db - reference to in-memory DB
 * @param {Function} saveDB - persists DB to disk
 */
async function pollWatchlist(client, db, saveDB) {
  const wallets = Object.values(db.watchlist ?? {});
  if (wallets.length === 0) return;

  console.log(`[WalletWatcher] Polling ${wallets.length} wallet(s)…`);

  for (const entry of wallets) {
    try {
      const trades = await getWalletRecentTrades(entry.address);

      // Find buy trades we haven't seen yet
      const newBuys = [];
      for (const trade of trades) {
        const txId = trade.transactionHash ?? trade.signature ?? null;
        if (!txId) continue;
        if (txId === entry.lastSeenTx) break; // stop at last known
        const type = trade.transactionType ?? trade.type ?? "";
        if (type === "buy") newBuys.push(trade);
      }

      // Alert for each new buy (oldest first)
      for (const trade of newBuys.reverse()) {
        try {
          const channel = await client.channels.fetch(entry.alertChannelId).catch(() => null);
          if (!channel) continue;
          await channel.send({ embeds: [buildWalletBuyEmbed(entry, trade)] });
          console.log(
            `[WalletWatcher] Buy alert sent for wallet ${entry.label || entry.address}`
          );
        } catch (err) {
          console.error("[WalletWatcher] Failed to send buy alert:", err.message);
        }
      }

      // Update lastSeenTx to most recent
      if (trades.length > 0) {
        const latestTx = trades[0].transactionHash ?? trades[0].signature ?? null;
        if (latestTx) {
          db.watchlist[entry.address.toLowerCase()].lastSeenTx = latestTx;
        }
      }
    } catch (err) {
      console.error(`[WalletWatcher] Error polling ${entry.address}:`, err.message);
    }
  }

  saveDB();
}

module.exports = { pollWatchlist };
