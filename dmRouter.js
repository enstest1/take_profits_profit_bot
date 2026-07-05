/** All DM sending — closed-DM safe with cooldown dedupe. */
import { EmbedBuilder } from 'discord.js';

const dmCooldown = new Map();

export async function sendDM(client, userId, embed, dedupeKey, cooldownMs = 60_000) {
  if (!userId || !embed) return false;
  if (dedupeKey && Date.now() - (dmCooldown.get(dedupeKey) || 0) < cooldownMs) return false;
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed instanceof EmbedBuilder ? embed : EmbedBuilder.from(embed)] });
    if (dedupeKey) dmCooldown.set(dedupeKey, Date.now());
    return true;
  } catch (e) {
    console.warn('[dm] cannot DM ' + userId + ': ' + (e.code || e.message));
    return false;
  }
}
