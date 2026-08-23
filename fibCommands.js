/**
 * fibCommands.js — /fibtrack slash command (builder + handler), self-contained.
 *
 * Wire-up in index.js (see INTEGRATION.md):
 *   import { fibtrackCommand, handleFibtrack } from './fibCommands.js';
 *   … add `fibtrackCommand,` to the commands array …
 *   … add the router line in interactionCreate …
 *
 * Persistence rules (important — see fib/store.js):
 *   • Manual entries live in db.fibWatch and are ONLY written through updateFibWatch
 *     (synchronous load-mutate-save).
 *   • Tokens auto-tracked by the main poller (AUTO_FIB_TRACKING) keep state at
 *     db.tokens[key].fib, owned by the poll cycle. Commands never mutate db.tokens —
 *     they steer the poller through small control flags on db.fibWatch[key]
 *     (suppress / recalcAt), which fib/evaluate.js reads each tick. This avoids the
 *     dbStore mergePollSnapshot mid-cycle clobber.
 */

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { FIB } from './fib/config.js';
import { initStateShell, armCycle, liveTick, barClose } from './fib/engine.js';
import { detectImpulse } from './fib/swingDetector.js';
import { fetchCandles, resolveTopPool, gtNetworkFor, findNetworkSlug } from './fib/geckoTerminal.js';
import { resolveTokenForFib } from './fib/resolve.js';
import { updateFibWatch, readFibWatch, describeStatus, pairFromDexUrl } from './fib/store.js';
import { renderFibChart } from './fib/chartRender.js';
import { chartFileName } from './fib/embeds.js';
import { loadDB, ensureDBSchema } from './dbStore.js';
import { makeStorageKey, CHAINS, enabledChains, isEvmAddress } from './chains.js';

const TF_CHOICES = [
  { name: '1m', value: '1m' },
  { name: '5m', value: '5m' },
  { name: '15m', value: '15m' },
  { name: '1h (default)', value: '1h' },
  { name: '4h', value: '4h' },
];
const MODE_CHOICES = [
  { name: 'standard — confirmed 1m closes (default)', value: 'standard' },
  { name: 'fast — instant on touch', value: 'fast' },
];
const CHAIN_CHOICES = [
  { name: 'solana', value: 'solana' },
  { name: 'base', value: 'base' },
  { name: 'ethereum', value: 'ethereum' },
  { name: 'robinhood', value: 'robinhood' },
  { name: 'ink', value: 'ink' },
  { name: 'hype (HyperEVM)', value: 'hype' },
];

export const fibtrackCommand = new SlashCommandBuilder()
  .setName('fibtrack')
  .setDescription('Fibonacci retracement tracker — golden zone, entry, and target alerts')
  .addSubcommand((sc) =>
    sc
      .setName('add')
      .setDescription('Track a token for fib retracement alerts (alerts land in this channel)')
      .addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true))
      .addStringOption((o) => o.setName('chain').setDescription('Chain (auto-detected if omitted)').addChoices(...CHAIN_CHOICES))
      .addStringOption((o) => o.setName('timeframe').setDescription('Anchor timeframe (default 1h)').addChoices(...TF_CHOICES))
      .addStringOption((o) => o.setName('mode').setDescription('Trigger mode (default standard)').addChoices(...MODE_CHOICES)),
  )
  .addSubcommand((sc) =>
    sc.setName('remove').setDescription('Stop fib tracking a token').addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true)),
  )
  .addSubcommand((sc) =>
    sc.setName('status').setDescription('Show fib state for a token').addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true)),
  )
  .addSubcommand((sc) => sc.setName('list').setDescription('List every fib-tracked token'))
  .addSubcommand((sc) =>
    sc
      .setName('recalculate')
      .setDescription('Force a fresh impulse detection / re-anchor now')
      .addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true))
      .addStringOption((o) => o.setName('timeframe').setDescription('Switch anchor timeframe').addChoices(...TF_CHOICES))
      .addStringOption((o) => o.setName('mode').setDescription('Switch trigger mode').addChoices(...MODE_CHOICES)),
  )
  .addSubcommand((sc) =>
    sc.setName('pause').setDescription('Pause fib alerts for a token').addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true)),
  )
  .addSubcommand((sc) =>
    sc.setName('resume').setDescription('Resume fib alerts for a token').addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true)),
  )
  .addSubcommand((sc) =>
    sc
      .setName('simulate')
      .setDescription('Dry-run: detect the impulse and show which alerts WOULD have fired (no tracking)')
      .addStringOption((o) => o.setName('ca').setDescription('Contract address').setRequired(true))
      .addStringOption((o) => o.setName('timeframe').setDescription('Anchor timeframe (default 1h)').addChoices(...TF_CHOICES)),
  );

/* ------------------------------------------------------------------ helpers */

function fmtUsd(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1) return '$' + n.toFixed(2);
  return '$' + n.toPrecision(3);
}

const MUTATING = new Set(['add', 'remove', 'recalculate', 'pause', 'resume']);

function roleGateOk(interaction, sub) {
  if (!MUTATING.has(sub)) return true;
  const allowed = FIB.ALLOWED_ROLES.split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return true;
  const roles = interaction.member?.roles?.cache;
  if (!roles) return false;
  return allowed.some((id) => roles.has(id));
}

/** Find the storage key for a raw CA across fibWatch + db.tokens (both enabled chains). */
function locate(raw) {
  const db = ensureDBSchema(loadDB());
  const watch = db.fibWatch || {};
  const candidates = [];
  for (const chainId of enabledChains()) {
    const addr = CHAINS[chainId].kind === 'evm' ? String(raw).toLowerCase() : String(raw);
    candidates.push(makeStorageKey(chainId, addr));
  }
  for (const key of candidates) {
    if (watch[key] && !watch[key].suppress && watch[key].fib) return { key, where: 'watch', db, entry: watch[key] };
  }
  for (const key of candidates) {
    if (db.tokens[key]?.fib) return { key, where: 'tokens', db, entry: db.tokens[key] };
  }
  for (const key of candidates) {
    if (watch[key]) return { key, where: 'watch-flags', db, entry: watch[key] };
    if (db.tokens[key]) return { key, where: 'tokens-nofib', db, entry: db.tokens[key] };
  }
  return null;
}

function bumpRev(fwEntry) {
  fwEntry.rev = (fwEntry.rev || 0) + 1;
}

/* ------------------------------------------------------------------ handler */

export async function handleFibtrack(interaction, client) {
  const sub = interaction.options.getSubcommand();

  if (!FIB.ENABLED) {
    return interaction.reply({ content: 'Fib tracking is disabled (FIB_TRACKING_ENABLED=false).', ephemeral: true });
  }
  if (!roleGateOk(interaction, sub)) {
    return interaction.reply({ content: 'You need a fib-manager role to run `/fibtrack ' + sub + '`.', ephemeral: true });
  }

  if (sub === 'add') return subAdd(interaction);
  if (sub === 'remove') return subRemove(interaction);
  if (sub === 'status') return subStatus(interaction);
  if (sub === 'list') return subList(interaction);
  if (sub === 'recalculate') return subRecalculate(interaction);
  if (sub === 'pause') return subPauseResume(interaction, true);
  if (sub === 'resume') return subPauseResume(interaction, false);
  if (sub === 'simulate') return subSimulate(interaction);
  return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
}

async function subAdd(interaction) {
  await interaction.deferReply();
  const raw = interaction.options.getString('ca', true).trim();
  const chainHint = interaction.options.getString('chain') || null;
  const mode = interaction.options.getString('mode') || 'standard';
  const tf = interaction.options.getString('timeframe') || (mode === 'fast' ? FIB.FAST_TIMEFRAME : FIB.DEFAULT_TIMEFRAME);

  const res = await resolveTokenForFib(raw, chainHint);
  if (!res.ok) return interaction.editReply('Could not add: ' + res.error);

  if (res.marketCap == null || res.marketCap < FIB.MIN_MCAP) {
    return interaction.editReply(
      '**' + res.symbol + '** is below the fib floor — mcap ' + fmtUsd(res.marketCap) +
      ' < ' + fmtUsd(FIB.MIN_MCAP) + '. Fib structure on nano-caps is noise; add it once it clears the floor.',
    );
  }

  const key = makeStorageKey(res.chainId, res.address);
  const db = ensureDBSchema(loadDB());

  if (db.tokens[key]?.fib) {
    // Auto-integrated already — clear any suppress flag (acts as resume) and report.
    updateFibWatch((fw) => {
      if (fw[key]?.suppress) delete fw[key];
    });
    return interaction.editReply(
      '**' + res.symbol + '** is already fib-tracked by the auto tracker — ' + describeStatus(db.tokens[key].fib) +
      '. Use `/fibtrack status` for details.',
    );
  }
  if (db.fibWatch?.[key]?.fib) {
    return interaction.editReply('**' + res.symbol + '** is already on the fib watchlist — ' + describeStatus(db.fibWatch[key].fib) + '.');
  }

  const created = updateFibWatch((fw) => {
    const shell = initStateShell(mode, tf);
    shell.status = 'detecting'; // mcap floor already verified above
    shell.nextDetectAt = 0;
    fw[key] = {
      chain: res.chainId,
      address: res.address,
      symbol: res.symbol,
      name: res.name,
      pairAddress: res.pairAddress || null,
      dexUrl: res.dexUrl || null,
      alertChannelId: interaction.channelId,
      addedByUserId: interaction.user.id,
      addedAt: Date.now(),
      rev: 0,
      fib: shell,
    };
    if (res.pairAddress) fw[key].fib.poolAddress = res.pairAddress;
    return fw[key];
  });

  const embed = new EmbedBuilder()
    .setColor(0x14b8a6)
    .setTitle('📐 Fib tracking armed: ' + res.symbol)
    .setDescription(
      '**' + res.name + '** on ' + res.chainId + '\n' +
      'Timeframe **' + tf + '** · mode **' + mode + '** · mcap ' + fmtUsd(res.marketCap) + '\n' +
      'Detecting the last major impulse now — alerts will land in this channel:\n' +
      '`golden 0.382 → entry touch 0.236 (chart) → entry held → reclaim → TP1 → TP2`',
    )
    .setFooter({ text: 'Levels are market structure, not financial advice · fib v1' })
    .setTimestamp();
  if (created.dexUrl) embed.addFields({ name: 'Chart', value: created.dexUrl, inline: false });
  return interaction.editReply({ embeds: [embed] });
}

async function subRemove(interaction) {
  const raw = interaction.options.getString('ca', true).trim();
  const loc = locate(raw);
  if (!loc) return interaction.reply({ content: 'That address is not fib-tracked.', ephemeral: true });

  if (loc.where === 'watch' || loc.where === 'watch-flags') {
    updateFibWatch((fw) => delete fw[loc.key]);
    return interaction.reply('Removed **' + (loc.entry.symbol || loc.key) + '** from the fib watchlist.');
  }
  // Auto-integrated token → set a suppress flag the poller reads each tick.
  updateFibWatch((fw) => {
    fw[loc.key] = { suppress: true, chain: loc.entry.chain, address: loc.entry.address, symbol: loc.entry.symbol, rev: 1 };
  });
  return interaction.reply(
    'Suppressed auto fib-tracking for **' + (loc.entry.symbol || loc.key) + '**. `/fibtrack add` or `resume` re-enables it.',
  );
}

async function subStatus(interaction) {
  const raw = interaction.options.getString('ca', true).trim();
  const loc = locate(raw);
  const fib = loc?.entry?.fib;
  if (!fib) return interaction.reply({ content: 'That address is not fib-tracked (no state yet).', ephemeral: true });

  const sym = loc.entry.symbol || loc.key;
  const lines = [
    '**Status:** ' + describeStatus(fib) + (loc.where === 'tokens' ? ' _(auto/integrated)_' : ' _(watchlist)_'),
    '**Mode / TF / metric:** ' + fib.mode + ' / ' + fib.timeframe + ' / ' + (fib.metric || '—'),
  ];
  if (fib.anchors) {
    lines.push('**Anchors:** low ' + fmtUsd(fib.anchors.low.v) + ' → high ' + fmtUsd(fib.anchors.high.v));
    lines.push(
      '**Levels:** golden ' + fmtUsd(fib.levels.goldenUpper) + '–' + fmtUsd(fib.levels.goldenLower) +
      Object.keys(fib.levels.alerts).map(Number).sort((a, b) => b - a)
        .map((r) => ' · ' + r + ' ' + fmtUsd(fib.levels.alerts[String(r)])).join(''),
    );
    if (fib.targets) lines.push('**Targets:** TP1 ' + fmtUsd(fib.targets.tp1) + ' · TP2 ' + fmtUsd(fib.targets.tp2));
    const fired = [];
    if (fib.fired?.golden) fired.push('golden');
    for (const r of Object.keys(fib.fired?.alerts || {})) if (fib.fired.alerts[r]) fired.push(r);
    if (fib.fired?.entryHeld) fired.push('held');
    if (fib.fired?.reclaim) fired.push('reclaim');
    if (fib.fired?.tp1) fired.push('tp1');
    if (fib.fired?.tp2) fired.push('tp2');
    lines.push('**Fired this cycle:** ' + (fired.length ? fired.join(', ') : 'none'));
  }
  if (fib.lastValue != null) lines.push('**Last value:** ' + fmtUsd(fib.lastValue));
  if (fib.lastError) lines.push('**Note:** ' + String(fib.lastError).slice(0, 180));

  const embed = new EmbedBuilder()
    .setColor(0x64748b)
    .setTitle('📐 Fib status: ' + sym)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'cycle #' + (fib.cycleId || 0) })
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

async function subList(interaction) {
  const db = ensureDBSchema(loadDB());
  const watch = db.fibWatch || {};
  const rows = [];
  for (const [key, w] of Object.entries(watch)) {
    if (w.suppress || !w.fib) continue;
    rows.push('• **' + (w.symbol || key) + '** _(watch, ' + w.fib.timeframe + ')_ — ' + describeStatus(w.fib));
  }
  for (const [key, t] of Object.entries(db.tokens || {})) {
    if (!t.fib) continue;
    if (watch[key]?.suppress) continue;
    rows.push('• **' + (t.symbol || key) + '** _(auto, ' + t.fib.timeframe + ')_ — ' + describeStatus(t.fib));
  }
  if (!rows.length) {
    return interaction.reply({ content: 'Nothing fib-tracked yet. `/fibtrack add ca:<address>` to start.', ephemeral: true });
  }
  const body = rows.slice(0, 30).join('\n') + (rows.length > 30 ? '\n… +' + (rows.length - 30) + ' more' : '');
  return interaction.reply({ embeds: [new EmbedBuilder().setColor(0x64748b).setTitle('📐 Fib-tracked tokens').setDescription(body)] });
}

async function subRecalculate(interaction) {
  const raw = interaction.options.getString('ca', true).trim();
  const tf = interaction.options.getString('timeframe') || null;
  const mode = interaction.options.getString('mode') || null;
  const loc = locate(raw);
  if (!loc || (!loc.entry?.fib && loc.where !== 'tokens')) {
    return interaction.reply({ content: 'That address is not fib-tracked.', ephemeral: true });
  }

  if (loc.where === 'watch') {
    updateFibWatch((fw) => {
      const w = fw[loc.key];
      if (!w) return;
      const shell = initStateShell(mode || w.fib.mode, tf || w.fib.timeframe);
      shell.cycleId = w.fib.cycleId || 0;
      shell.status = 'detecting';
      shell.nextDetectAt = 0;
      if (w.pairAddress) shell.poolAddress = w.pairAddress;
      w.fib = shell;
      bumpRev(w);
    });
    return interaction.reply('Recalculating **' + (loc.entry.symbol || loc.key) + '** — fresh impulse detection queued.');
  }

  // Integrated token → timestamped control flag; poller applies it on its next tick.
  updateFibWatch((fw) => {
    const cur = fw[loc.key] || { chain: loc.entry.chain, address: loc.entry.address, symbol: loc.entry.symbol };
    cur.recalcAt = Date.now();
    if (tf) cur.timeframe = tf;
    if (mode) cur.mode = mode;
    delete cur.suppress;
    bumpRev(cur);
    fw[loc.key] = cur;
  });
  return interaction.reply('Recalculation queued for **' + (loc.entry.symbol || loc.key) + '** — applies on the next poll tick (~15s).');
}

async function subPauseResume(interaction, pause) {
  const raw = interaction.options.getString('ca', true).trim();
  const loc = locate(raw);
  if (!loc) return interaction.reply({ content: 'That address is not fib-tracked.', ephemeral: true });

  if (loc.where === 'watch' || (loc.where === 'watch-flags' && loc.entry.fib)) {
    updateFibWatch((fw) => {
      const w = fw[loc.key];
      if (!w?.fib) return;
      if (pause) {
        w.fib.status = 'paused';
      } else if (w.fib.status === 'paused') {
        w.fib.status = w.fib.anchors ? 'armed' : 'detecting';
        w.fib.nextDetectAt = 0;
      }
      bumpRev(w);
    });
    return interaction.reply((pause ? 'Paused' : 'Resumed') + ' fib alerts for **' + (loc.entry.symbol || loc.key) + '**.');
  }

  // Integrated token → suppress flag on/off.
  updateFibWatch((fw) => {
    if (pause) {
      fw[loc.key] = { suppress: true, chain: loc.entry.chain, address: loc.entry.address, symbol: loc.entry.symbol, rev: 1 };
    } else if (fw[loc.key]?.suppress) {
      delete fw[loc.key];
    }
  });
  return interaction.reply((pause ? 'Paused (suppressed)' : 'Resumed') + ' auto fib-tracking for **' + (loc.entry.symbol || loc.key) + '**.');
}

async function subSimulate(interaction) {
  await interaction.deferReply();
  const raw = interaction.options.getString('ca', true).trim();
  const tf = interaction.options.getString('timeframe') || FIB.DEFAULT_TIMEFRAME;

  const res = await resolveTokenForFib(raw, null);
  if (!res.ok) return interaction.editReply('Simulate failed: ' + res.error);

  // pool: prefer the DexScreener pair, fall back to GT lookup
  let pool = res.pairAddress || pairFromDexUrl(res.dexUrl);
  if (!pool) {
    const r = await resolveTopPool(res.chainId, res.address);
    if (r.error) {
      let hint = '';
      if (r.error === 'unsupported_chain:' + res.chainId || r.error === 'token_not_indexed') {
        const slug = await findNetworkSlug(res.chainId);
        hint = slug ? ' (GT network slug may be `' + slug.id + '` — set FIB_GT_NETWORK_' + res.chainId.toUpperCase() + ')' : '';
      }
      return interaction.editReply('Simulate failed resolving pool: ' + r.error + hint);
    }
    pool = r.poolAddress;
  }

  const got = await fetchCandles(res.chainId, pool, tf, { fresh: true });
  if (got.error) return interaction.editReply('Simulate failed fetching candles: ' + got.error);

  const factor = res.marketCap && res.price ? res.marketCap / res.price : null;
  const candles = factor
    ? got.candles.map((c) => ({ t: c.t, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v }))
    : got.candles;

  const det = detectImpulse(candles, {
    minImpulsePct: FIB.MIN_IMPULSE_PCT,
    minCandles: FIB.MIN_CANDLES,
    pivotStrength: FIB.PIVOT_STRENGTH,
    reversalPct: FIB.REVERSAL_PCT,
    atrMult: FIB.ATR_MULT,
    goldenUpper: FIB.HIGH_CONFIRM_RATIO,
    anchorOrigin: FIB.ANCHOR_ORIGIN,
    launchFallback: true,
  });
  if (!det.ok) return interaction.editReply('**' + res.symbol + '** (' + tf + '): no cycle — ' + det.reason);

  // Replay candles after the swing high through the engine (tf-candle approximation of the live feed).
  const state = initStateShell('standard', tf);
  state.metric = factor ? 'marketCap' : 'price';
  state.supplyFactor = factor;
  state.poolAddress = pool;
  armCycle(state, det, null);
  const hiIdx = candles.findIndex((c) => c.t >= det.high.t);
  const events = [];
  let prev = null;
  for (let i = Math.max(0, hiIdx); i < candles.length; i++) {
    const c = candles[i];
    for (const v of [c.h, c.l]) {
      events.push(...liveTick(state, prev, v, c.t));
      prev = v;
    }
    events.push(...barClose(state, c.c, c.t));
    prev = c.c;
    if (state.status === 'invalidated' || state.status === 'completed') break;
  }

  const evLine = events.length
    ? events.map((e) => '`' + e.kind + '` @ ' + fmtUsd(e.value)).join(' → ')
    : 'none yet (still above the golden zone)';
  const lines = [
    '**Impulse:** ' + fmtUsd(det.low.v) + ' → ' + fmtUsd(det.high.v) + (factor ? ' (mcap)' : ' (price)'),
    '_' + det.reason + '_',
    '**Golden zone:** ' + fmtUsd(state.levels.goldenUpper) + ' – ' + fmtUsd(state.levels.goldenLower),
    '**Alert levels:** ' + Object.keys(state.levels.alerts).map(Number).sort((a, b) => b - a)
      .map((r) => r + ' → ' + fmtUsd(state.levels.alerts[String(r)])).join(' · '),
    state.targets ? '**Targets:** TP1 ' + fmtUsd(state.targets.tp1) + ' · TP2 ' + fmtUsd(state.targets.tp2) : null,
    '**Replay (would have fired):** ' + evLine,
    '**End state:** ' + describeStatus(state),
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(0x14b8a6)
    .setTitle('🧪 Fib simulate: ' + res.symbol + ' [' + tf + ']')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Dry run — nothing was added to tracking · not financial advice' })
    .setTimestamp();

  const png = await renderFibChart({ candles, state, symbol: res.symbol, currentValue: candles[candles.length - 1].c });
  if (png) {
    const name = chartFileName(res.symbol);
    embed.setImage('attachment://' + name);
    return interaction.editReply({ embeds: [embed], files: [{ attachment: png, name }] });
  }
  return interaction.editReply({ embeds: [embed] });
}
