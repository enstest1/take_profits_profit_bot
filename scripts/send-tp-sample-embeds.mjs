/**
 * Post sample 1x / 5x Take Profit embeds to a channel (format preview only).
 * Usage: npm run tp:sample
 * Requires DISCORD_TOKEN in .env and bot access to the target channel.
 */
import 'dotenv/config';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

const CHANNEL_ID = '1084990746207207499';

function fmtAgeLabel(ms) {
  if (!ms) return '—';
  const diff = Date.now() - Number(ms);
  const mi = Math.floor(diff / 60000);
  const h = Math.floor(mi / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d === 1 ? '1 day' : d + ' days';
  if (h > 0) return h === 1 ? '1 hour' : h + ' hours';
  if (mi > 0) return mi === 1 ? '1 minute' : mi + ' minutes';
  return 'just now';
}

function takeProfitDescription(mint, postedBy, postedAt) {
  return (
    '💰💰💰 **Take Profit** 💰💰💰\n' +
    '`' +
    mint +
    '`\n' +
    '**' +
    postedBy +
    '** - ' +
    fmtAgeLabel(postedAt) +
    '\n' +
    '[Lute](https://lute.gg/trade/' +
    mint +
    ') · [Trench](https://trench.com/trade/' +
    mint +
    ')'
  );
}

// Demo mint + thumbnail that should load (real pump token image).
const SAMPLE_MINT = 'EZfw7Affwc9j8QCahC9zpa1DSCJRcGcyWa6W1ggnpump';
const SAMPLE_THUMB =
  'https://dd.dexscreener.com/ds-data/tokens/solana/' + SAMPLE_MINT + '.png?size=lg';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  try {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      console.error('Missing DISCORD_TOKEN in .env');
      process.exit(1);
    }

    const channel = await client.channels.fetch(CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      console.error('Channel not found or not text-based:', CHANNEL_ID);
      process.exit(1);
    }

    const postedAt = Date.now() - 42 * 60 * 60 * 1000;
    const caller = 'demo_caller';

    const embed1x = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🎯 1x — Sample Runner (DEMO)')
      .setDescription(takeProfitDescription(SAMPLE_MINT, caller, postedAt))
      .setThumbnail(SAMPLE_THUMB);

    const embed5x = new EmbedBuilder()
      .setColor(0xffd700)
      .setTitle('🎯 5x — Sample Runner (DEMO)')
      .setDescription(takeProfitDescription(SAMPLE_MINT, caller, postedAt))
      .setThumbnail(SAMPLE_THUMB);

    await channel.send({ embeds: [embed1x, embed5x] });
    console.log('Posted sample 1x + 5x embeds to', CHANNEL_ID);
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
