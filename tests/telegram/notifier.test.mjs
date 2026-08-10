import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EmbedBuilder } from 'discord.js';
import {
  renderEmbedForTelegram,
  truncateTelegramText,
} from '../../notifier.js';

describe('renderEmbedForTelegram', () => {
  it('escapes & < > inside dynamic values before markdown conversion', () => {
    const embed = new EmbedBuilder()
      .setTitle('A & B <C>')
      .setDescription('x > y & z < w');
    const { text } = renderEmbedForTelegram(embed);
    assert.match(text, /A &amp; B &lt;C&gt;/);
    assert.match(text, /x &gt; y &amp; z &lt; w/);
    assert.equal(text.includes('<C>'), false);
  });

  it('converts Discord links, bold, and backticks to Telegram HTML', () => {
    const embed = new EmbedBuilder()
      .setTitle('Alert')
      .setDescription('See [Dex](https://dex.example/x) — **bold** and `So11111111111111111111111111111111111111112`');
    const { text } = renderEmbedForTelegram(embed);
    assert.match(text, /<a href="https:\/\/dex\.example\/x">Dex<\/a>/);
    assert.match(text, /<b>bold<\/b>/);
    assert.match(text, /<code>So11111111111111111111111111111111111111112<\/code>/);
  });

  it('ignores attachment:// image URLs (Discord-internal)', () => {
    const embed = new EmbedBuilder()
      .setTitle('Fib entry')
      .setDescription('chart below')
      .setImage('attachment://fib-SYM.png')
      .setThumbnail('attachment://thumb.png');
    const { photoUrl } = renderEmbedForTelegram(embed);
    assert.equal(photoUrl, null);
  });

  it('keeps http embed image as photoUrl; omits thumbnail', () => {
    const embed = new EmbedBuilder()
      .setTitle('T')
      .setImage('https://example.com/chart.png');
    const { photoUrl } = renderEmbedForTelegram(embed);
    assert.equal(photoUrl, 'https://example.com/chart.png');

    const thumbOnly = new EmbedBuilder()
      .setTitle('T')
      .setThumbnail('https://example.com/t.png');
    assert.equal(renderEmbedForTelegram(thumbOnly).photoUrl, null);
  });

  it('lays out fields and footer', () => {
    const embed = new EmbedBuilder()
      .setTitle('Title')
      .setDescription('Desc')
      .addFields(
        { name: 'MCap', value: '**$1.2M**' },
        { name: 'CA', value: '`abc123`' },
      )
      .setFooter({ text: 'solana' });
    const { text } = renderEmbedForTelegram(embed);
    assert.match(text, /^<b>Title<\/b>/);
    assert.match(text, /Desc/);
    assert.match(text, /<b>MCap<\/b>: <b>\$1\.2M<\/b>/);
    assert.match(text, /<b>CA<\/b>: <code>abc123<\/code>/);
    assert.match(text, /<i>solana<\/i>/);
  });

  it('falls back to author.name when title is missing (auto-track cards)', () => {
    const embed = new EmbedBuilder()
      .setAuthor({ name: '📡 Auto-tracking: Foo (FOO)' })
      .setDescription('Posted by **alice**');
    const { text } = renderEmbedForTelegram(embed);
    assert.match(text, /<b>📡 Auto-tracking: Foo \(FOO\)<\/b>/);
    assert.match(text, /Posted by <b>alice<\/b>/);
  });
});

describe('truncateTelegramText', () => {
  it('enforces the 4096 truncation boundary', () => {
    const exact = 'a'.repeat(4096);
    assert.equal(truncateTelegramText(exact).length, 4096);
    const over = 'b'.repeat(4097);
    const cut = truncateTelegramText(over);
    assert.equal(cut.length, 4096);
    assert.equal(cut, 'b'.repeat(4096));
  });
});
