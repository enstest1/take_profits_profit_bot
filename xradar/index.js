/**
 * xradar/index.js — follow-radar wiring entry point.
 *
 * Full follow-radar monitor lands here; xfeed reuses xradar/xClient.js only.
 * Flag-gated so boot stays safe when XRADAR_ENABLED is unset.
 */

export function startXRadar(_client) {
  if (process.env.XRADAR_ENABLED !== 'true') {
    console.log('[xradar] disabled (XRADAR_ENABLED not true)');
    return;
  }
  console.log('[xradar] enabled but monitor not wired on this branch yet');
}
