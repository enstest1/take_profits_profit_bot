/**
 * Post mock trencher-style alert cards to a test Discord channel.
 * Preview only — does not touch poller logic or production trenches channel.
 *
 * Usage: npm run trencher:mock
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { fmtCompactK, fmtClockTime } from '../autotrackHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CHANNEL_ID = process.env.TRENCHER_MOCK_CHANNEL_ID || '1535879065720856596';

const RH_LOGO = path.join(ROOT, 'assets', 'chains', 'robinhood.png');
const RH_LOGO_NAME = 'robinhood.png';
const SOL_LOGO = path.join(ROOT, 'assets', 'chains', 'solana.png');
const SOL_LOGO_NAME = 'solana.png';
const CHART_CANDIDATES = [
  path.join(ROOT, 'assets', 'mock', 'cashbird-price-chart.png'),
  path.join(ROOT, 'assets', 'mock', 'cashbird-chart.png'),
  path.join(ROOT, 'fib-sim-CASHBIRD.png'),
];
const CHART_NAME = 'cashbird-chart.png';

const MOCK = {
  chainId: 'robinhood',
  chainName: 'Robinhood',
  symbol: 'CASHBIRD',
  name: 'Cash Delivery Bird',
  ca: '0x91554e79a17c18990034d1ec3c4f492086d7b2cc',
  caller: 'trench_king',
  calledAgo: '4h 18m',
  callMcap: 26_000,
  nowMcap: 158_000,
  liquidity: 31_000,
  windows: [
    { label: '1h', vol: 673_000, pct: 58.4 },
    { label: '30m', vol: 412_000, pct: 31.2 },
    { label: '15m', vol: 89_000, pct: 12.1 },
  ],
  dexUrl: 'https://dexscreener.com/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc',
  basedUrl: 'https://basedbot.app/token/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc',
  fomoUrl: 'https://fomo.family/tokens/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc',
  thumb: 'https://dd.dexscreener.com/ds-data/tokens/robinhood/0x91554e79a17c18990034d1ec3c4f492086d7b2cc.png?size=lg',
};

const AUTOTRACK_MOCK = {
  chainName: 'Robinhood',
  symbol: 'THEO',
  name: 'Fomo Inu',
  caller: 'rolzs',
  tokenAge: '⚡ 1h old',
  mcap: 711_000,
  postedAt: new Date().setHours(22, 8, 0, 0),
  thumb: 'https://dd.dexscreener.com/ds-data/tokens/robinhood/0x7b630f080807df83908b4ade46ba6396ee66b098.png?size=lg',
};

function fmtRick(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) {
    const k = n / 1e3;
    const s = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return s.replace(/\.0$/, '') + 'K';
  }
  if (abs >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  return n.toPrecision(3);
}

function buildMcapLiqLine(m) {
  return '💎 `' + fmtRick(m.callMcap) + '` → `' + fmtRick(m.nowMcap) + '` · 💧 `' + fmtRick(m.liquidity) + '`';
}

function takeProfitBanner() {
  return '💰💰💰 **Take Profit** 💰💰💰';
}

function buildChartLeadBlock(m, alertKind) {
  if (alertKind === 'autotrack') return buildLinks(m);
  return buildLinks(m) + '\n\n' + takeProfitBanner();
}

function buildAuthorLine(m, alertKind) {
  if (alertKind === 'gain75') return m.chainName + ' · ' + m.symbol + ' · +75% 🚀';
  return m.chainName + ' · ' + m.symbol + ' · ' + alertKind.replace('tier', '') + 'x 🚀';
}

function buildLinks(m) {
  return '[DEX](' + m.dexUrl + ') · [BasedBot](' + m.basedUrl + ') · [FOMO](' + m.fomoUrl + ')';
}

function buildWindowInline(m) {
  if (!Array.isArray(m.windows) || !m.windows.length) return '';
  return m.windows
    .map((w) => {
      const sign = w.pct >= 0 ? '+' : '';
      return w.label + ' ' + fmtRick(w.vol) + ' ' + sign + w.pct + '%';
    })
    .join(' · ');
}

function buildCallerFooter(m) {
  return '📞 ' + m.caller + ' · ' + m.calledAgo;
}

function buildMilestoneBody(m, alertKind = 'tier5') {
  return [
    m.name + ' · `' + fmtRick(m.nowMcap) + '`',
    buildMcapLiqLine(m),
    buildWindowInline(m),
    buildChartLeadBlock(m, alertKind),
  ].join('\n');
}

/** Production-matching autotrack card — no chart, no thumbnail, no liq line. */
function buildAutotrackEmbed(m) {
  const ind = '  ';
  const description = [
    '**' + m.name + '**' + ind + '— **' + m.symbol + '**',
    ind + '☎️ **' + m.caller + '** · ' + m.tokenAge,
    ind + '💎 `' + fmtCompactK(m.mcap) + '` · ⌚ ' + fmtClockTime(m.postedAt),
  ].join('\n');

  return new EmbedBuilder()
    .setColor(0x00ccff)
    .setAuthor({
      name: m.chainName + ' · Auto-Tracking 📡',
      iconURL: 'attachment://' + RH_LOGO_NAME,
    })
    .setDescription(description)
    .setThumbnail(m.thumb || null);
}

function buildEmbed(m, alertKind, color, chainLogoName = RH_LOGO_NAME) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({
      name: buildAuthorLine(m, alertKind),
      iconURL: 'attachment://' + chainLogoName,
    })
    .setDescription(buildMilestoneBody(m, alertKind))
    .setFooter({ text: buildCallerFooter(m) })
    .setThumbnail(m.thumb || null)
    .setImage('attachment://' + CHART_NAME);
}

function buildSolEmbed() {
  const m = {
    ...MOCK,
    chainId: 'solana',
    chainName: 'Solana',
    symbol: 'DEMO',
    name: 'Demo Runner',
    dexUrl: 'https://dexscreener.com/solana/EZfw7Affwc9j8QCahC9zpa1DSCJRcGcyWa6W1ggnpump',
    basedUrl: 'https://basedbot.app/token/solana/EZfw7Affwc9j8QCahC9zpa1DSCJRcGcyWa6W1ggnpump',
    fomoUrl: 'https://fomo.family/solana/EZfw7Affwc9j8QCahC9zpa1DSCJRcGcyWa6W1ggnpump',
    thumb: 'https://dd.dexscreener.com/ds-data/tokens/solana/EZfw7Affwc9j8QCahC9zpa1DSCJRcGcyWa6W1ggnpump.png?size=lg',
  };

  return new EmbedBuilder()
    .setColor(0xffd700)
    .setAuthor({
      name: 'Solana · DEMO · 1x 🚀',
      iconURL: 'attachment://' + SOL_LOGO_NAME,
    })
    .setDescription(buildMilestoneBody(m, 'tier1'))
    .setFooter({ text: buildCallerFooter(m) })
    .setThumbnail(m.thumb)
    .setImage('attachment://' + CHART_NAME);
}

function resolveChartPath() {
  for (const p of CHART_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function buildFiles(chainLogoBuf, chainLogoName, withChart = true) {
  const files = [new AttachmentBuilder(chainLogoBuf, { name: chainLogoName })];
  if (withChart) {
    files.push(new AttachmentBuilder(fs.readFileSync(resolveChartPath()), { name: CHART_NAME }));
  }
  return files;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    if (!process.env.DISCORD_TOKEN) {
      console.error('Missing DISCORD_TOKEN in .env');
      process.exit(1);
    }
    if (!fs.existsSync(RH_LOGO)) {
      console.error('Missing Robinhood logo at', RH_LOGO);
      process.exit(1);
    }
    if (!resolveChartPath()) {
      console.error('No chart PNG. Run: npm run trencher:chart');
      process.exit(1);
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel?.isTextBased()) {
      console.error('Channel not found:', CHANNEL_ID);
      process.exit(1);
    }

    const rhLogoBuf = fs.readFileSync(RH_LOGO);
    const solLogoBuf = fs.existsSync(SOL_LOGO) ? fs.readFileSync(SOL_LOGO) : rhLogoBuf;

    await channel.send({
      content:
        '**Trencher mock v29** — autotrack: **Fomo Inu** — **THEO** (both bold).',
    });

    const cards = [
      { kind: 'tier5', color: 0xffd700, label: '🎯 5x' },
      { kind: 'gain75', color: 0x00ff88, label: '📈 +75%' },
    ];

    for (const c of cards) {
      await channel.send({
        embeds: [buildEmbed(MOCK, c.kind, c.color, RH_LOGO_NAME)],
        files: buildFiles(rhLogoBuf, RH_LOGO_NAME),
      });
      console.log('Posted', c.label);
    }

    await channel.send({
      embeds: [buildAutotrackEmbed(AUTOTRACK_MOCK)],
      files: buildFiles(rhLogoBuf, RH_LOGO_NAME, false),
    });
    console.log('Posted 📡 Auto-track');

    await channel.send({
      embeds: [buildSolEmbed()],
      files: buildFiles(solLogoBuf, SOL_LOGO_NAME),
    });
    console.log('Posted Sol 1x');

    console.log('Done — channel', CHANNEL_ID);
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  } finally {
    client.destroy();
    process.exit(0);
  }
});

client.login(process.env.DISCORD_TOKEN).catch((e) => {
  console.error('Login failed:', e.message || e);
  process.exit(1);
});
