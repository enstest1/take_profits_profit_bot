/** Railway start router — main bot vs Warden share one repo / railway.toml. */
import { resolveGitSha } from './deploySha.js';

const service = process.env.RAILWAY_SERVICE_NAME || '';
console.log('[boot] service=' + (service || 'main') + ' git sha=' + resolveGitSha());

if (service === 'warden') {
  await import('./warden/index.js');
} else if (process.env.PLATFORM === 'telegram') {
  await import('./telegram.js');
} else {
  await import('./index.js');
}
