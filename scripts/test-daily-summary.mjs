/**
 * Preview the daily summary embed body (no Discord post).
 * Run from repo root: npm run test:summary
 */
import 'dotenv/config';
import { buildDailySummaryParts } from '../poller.js';

const parts = await buildDailySummaryParts();

console.log('='.repeat(64));
console.log(parts.title);
console.log('='.repeat(64));
console.log(parts.description);
console.log('='.repeat(64));
if (parts.footerText) {
  console.log('Footer:', parts.footerText);
}
console.log('Tracked tokens:', parts.tokenCount);
