/** Warden bounds — mirrors §3 of warden.md. */
export const BOUNDS = {
  velocityWindow: 10,
  callChannels: 10,
  tags: 3,
  positionsPerToken: 200,
  milestonesFired: 20,
};

export const IMMUTABLE = ['postedBy', 'postedByUserId', 'postedAt', 'priceAtCall', 'calledInGuild'];

export const STATUS_INTERVAL_MS = 60_000;
export const SNAPSHOT_INTERVAL_MS = 5 * 60_000;
export const PRICE_TRUTH_INTERVAL_MS = 10 * 60_000;
export const MASS_DELETE_PCT = 0.1;
export const POLL_STALE_MULT = 3;
export const HEARTBEAT_FAIL_MS = 3 * 60_000;
export const DEPLOY_WINDOW_MS = 10 * 60_000;
export const CRITICAL_COOLDOWN_MS = 6 * 60 * 60_000;
export const WARN_COOLDOWN_MS = 24 * 60 * 60_000;

/** Default audit channel — user personal channel. */
export const DEFAULT_WARDEN_CHANNEL_ID = '1484009058401910844';
