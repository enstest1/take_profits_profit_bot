/**
 * fib/embeds.js — one builder for every fib alert kind.
 * buildFibEmbed(ev, state, ctx, hasChart) → EmbedBuilder
 */

import { EmbedBuilder } from 'discord.js';
import { chainBadge, chainLabel } from '../chains.js';
import { FIB } from './config.js';

const DISCLAIMER = 'Levels are market structure, not financial advice · fib v1';

/** Attachment-safe chart filename shared by embeds + senders (symbols can contain emoji etc). */
export function chartFileName(symbol) {
  const safe = String(symbol || 'token').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'token';
  return 'fib-' + safe + '.png';
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return '$' + n.toFixed(2);
  return '$' + n.toPrecision(3);
}

function fmtAge(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.round(ms / 60_000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function ratioLabel(r) {
  return Number(r).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

const KINDS = {
  golden: {
    color: 0x14b8a6,
    emoji: '🌗',
    title: (s, c) => c.symbol + ' entered the golden zone',
    line: (ev, s) =>
      'Retraced into the **' + ratioLabel(FIBG().u) + ' – ' + ratioLabel(FIBG().l) + '** band (' +
      fmtUsd(s.levels.goldenUpper) + ' → ' + fmtUsd(s.levels.goldenLower) + ').',
  },
  level: {
    color: 0xf59e0b,
    emoji: '📉',
    title: (s, c, ev) => c.symbol + ' broke the ' + ratioLabel(ev.ratio) + ' fib',
    line: (ev) => 'Crossed below **' + ratioLabel(ev.ratio) + '** (' + fmtUsd(ev.level) + ') — golden zone lost.',
  },
  entry_touch: {
    color: 0xef4444,
    emoji: '🎯',
    title: (s, c, ev) => c.symbol + ' tagged the ' + ratioLabel(ev.ratio) + ' entry',
    line: (ev, s) =>
      'Wick touched the **' + ratioLabel(ev.ratio) + '** level (' + fmtUsd(ev.level) +
      ') — the top of the red zone. Deepest tracked retracement of this cycle.' +
      (s.targets ? '\nTargets armed: **TP1 ' + fmtUsd(s.targets.tp1) + '** · **TP2 ' + fmtUsd(s.targets.tp2) + '**' : ''),
  },
  entry_held: {
    color: 0x22c55e,
    emoji: '🛡️',
    title: (s, c) => c.symbol + ' held the entry',
    line: (ev, s) =>
      'Closed back above **' + ratioLabel(s.entryRatio) + '** (' + fmtUsd(s.entryValue) + ') on consecutive 1m closes — level defended.',
  },
  reclaim: {
    color: 0x3b82f6,
    emoji: '🔁',
    title: (s, c) => c.symbol + ' reclaimed the swing high',
    line: (ev) => 'Back at the impulse high (**' + fmtUsd(ev.level) + '**). Extension targets in play.',
  },
  tp1: {
    color: 0x8b5cf6,
    emoji: '💰',
    title: (s, c) => c.symbol + ' hit TP1 (1.618 ext)',
    line: (ev) => 'Tagged **TP1 ' + fmtUsd(ev.level) + '** — classic 1.618 extension of the anchored impulse.',
  },
  tp2: {
    color: 0xd946ef,
    emoji: '🏁',
    title: (s, c) => c.symbol + ' hit TP2 — cycle complete',
    line: (ev) => 'Tagged **TP2 ' + fmtUsd(ev.level) + '** (re-pull off the entry). Fib cycle marked complete.',
  },
  invalidated: {
    color: 0x6b7280,
    emoji: '🧯',
    title: (s, c) => c.symbol + ' fib cycle invalidated',
    line: (ev) =>
      '1m close below the swing low (**' + fmtUsd(ev.level) + '**) — structure is gone. Will re-scan for a fresh impulse.',
  },
};

function FIBG() {
  return { u: FIB.GOLDEN_UPPER, l: FIB.GOLDEN_LOWER };
}

export function buildFibEmbed(ev, state, ctx, hasChart = false) {
  const spec = KINDS[ev.kind] || KINDS.level;
  const metricName = state.metric === 'price' ? 'price' : 'market cap';

  const embed = new EmbedBuilder()
    .setColor(spec.color)
    .setTitle(spec.emoji + ' ' + chainBadge(ctx.chainId) + ' ' + spec.title(state, ctx, ev) + ' [fib ' + state.timeframe + ']')
    .setDescription(spec.line(ev, state))
    .addFields(
      { name: 'Now (' + metricName + ')', value: fmtUsd(ev.value), inline: true },
      { name: 'Swing low → high', value: fmtUsd(state.anchors.low.v) + ' → ' + fmtUsd(state.anchors.high.v), inline: true },
      { name: 'Impulse age', value: fmtAge(Date.now() - (state.anchors.low.t || 0)), inline: true },
    )
    .setFooter({ text: DISCLAIMER + ' · cycle #' + state.cycleId + ' · ' + state.mode })
    .setTimestamp();

  if (ev.kind === 'golden' || ev.kind === 'level') {
    embed.addFields({
      name: 'Next levels',
      value: Object.keys(state.levels.alerts)
        .map(Number)
        .sort((a, b) => b - a)
        .map((r) => ratioLabel(r) + ' → ' + fmtUsd(state.levels.alerts[String(r)]))
        .join('  ·  '),
      inline: false,
    });
  }

  if (ev.kind === 'entry_touch' && hasChart) {
    embed.setImage('attachment://' + chartFileName(ctx.symbol));
  }

  const links = [];
  if (ctx.dexUrl) links.push('[Chart](' + ctx.dexUrl + ')');
  embed.addFields({
    name: chainLabel(ctx.chainId),
    value: '`' + ctx.address + '`' + (links.length ? '\n' + links.join(' · ') : ''),
    inline: false,
  });

  return embed;
}
