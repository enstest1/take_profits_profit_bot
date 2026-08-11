import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AttachmentBuilder } from 'discord.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CHART_ATTACHMENT_NAME = 'price-chart.png';

/** Chain logo attachment when assets/chains/<id>.png exists. */
export function chainLogoAttachment(chainId) {
  const name = String(chainId || 'solana').toLowerCase() + '.png';
  const filePath = path.join(ROOT, 'assets', 'chains', name);
  if (!fs.existsSync(filePath)) return null;
  return {
    name,
    file: new AttachmentBuilder(fs.readFileSync(filePath), { name }),
  };
}
