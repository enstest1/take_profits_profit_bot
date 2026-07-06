/** Railway start router — main bot vs Warden share one repo / railway.toml. */
const service = process.env.RAILWAY_SERVICE_NAME || '';
if (service === 'warden') {
  await import('./warden/index.js');
} else {
  await import('./index.js');
}
