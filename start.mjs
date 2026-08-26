/** Railway start router — main bot vs Warden share one repo / railway.toml. */
import { resolveGitSha } from './deploySha.js';

const service = process.env.RAILWAY_SERVICE_NAME || '';
console.log('[boot] service=' + (service || 'main') + ' git sha=' + resolveGitSha());

// Knowledge archive runs inside the profit bot (KB_ENABLED). A Railway
// service named "knowledge" with repo-root start.mjs would be a second
// profit-bot process — refuse rather than double-login the gateway.
if (/knowledge/i.test(service)) {
  console.error(
    '[boot] service "' + service + '" looks like a knowledge service, but start.mjs is the profit-bot router. ' +
      'Set KB_ENABLED=true on take_profits_profit_bot instead. Refusing to start.',
  );
  process.exit(1);
}

if (service === 'warden') {
  await import('./warden/index.js');
} else if (process.env.PLATFORM === 'telegram') {
  await import('./telegram.js');
} else {
  await import('./index.js');
}
