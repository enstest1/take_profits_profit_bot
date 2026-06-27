import fs from 'fs';
import path from 'path';

const DATA_DIR = fs.existsSync('/data') ? '/data' : path.dirname(new URL(import.meta.url).pathname);
export const COMEBACK_STATE_FILE = path.join(DATA_DIR, '.tp_comeback_cycles');

function envTruthy(name) {
  const v = process.env[name];
  return v === '1' || v === 'true' || v === 'yes';
}

function parseEnvInt(name, fallback = 0) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readComebackRemaining() {
  try {
    if (!fs.existsSync(COMEBACK_STATE_FILE)) return 0;
    const n = parseInt(fs.readFileSync(COMEBACK_STATE_FILE, 'utf8'), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Arm comeback silence from COMEBACK_SILENCE_CYCLES (call once at boot). */
export function initAlertGate() {
  const cycles = parseEnvInt('COMEBACK_SILENCE_CYCLES', 0);
  if (cycles > 0) {
    fs.writeFileSync(COMEBACK_STATE_FILE, String(cycles));
    console.log(
      '[comeback] armed ' +
        cycles +
        ' silent poll cycle(s) — milestone/price alerts sync to DB only (new CA confirmations still post)',
    );
  } else {
    if (readComebackRemaining() > 0) {
      try {
        fs.unlinkSync(COMEBACK_STATE_FILE);
        console.log('[comeback] COMEBACK_SILENCE_CYCLES unset — cleared silence, alerts live');
      } catch (e) {
        console.error('[comeback] failed to clear silence file:', e.message);
      }
    }
  }

  if (envTruthy('MAINTENANCE_MODE')) {
    console.log('[maintenance] MAINTENANCE_MODE on — all Discord alerts suppressed until env is cleared');
  }
}

/** Current silence state for logs and inspect script. */
export function getAlertSilenceStatus() {
  if (envTruthy('MAINTENANCE_MODE')) {
    return { silenced: true, reason: 'maintenance', remaining: null, total: null };
  }
  const remaining = readComebackRemaining();
  if (remaining > 0) {
    return { silenced: true, reason: 'comeback', remaining, total: null };
  }
  return { silenced: false, reason: null, remaining: 0, total: null };
}

export function shouldSilenceAlerts() {
  return getAlertSilenceStatus().silenced;
}

/** Call once at end of each poll cycle when comeback countdown is active. */
export function tickComebackAfterPollCycle() {
  if (envTruthy('MAINTENANCE_MODE')) return;
  const remaining = readComebackRemaining();
  if (remaining <= 0) return;

  const next = remaining - 1;
  if (next <= 0) {
    try {
      fs.unlinkSync(COMEBACK_STATE_FILE);
    } catch {}
    console.log('[comeback] silence complete — Discord alerts enabled');
  } else {
    fs.writeFileSync(COMEBACK_STATE_FILE, String(next));
    console.log('[comeback] ' + next + ' silent poll cycle(s) remaining');
  }
}
