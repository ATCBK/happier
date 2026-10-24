/**
 * Daemon-owned parking window for machine watches. Mounted clients keep one watch outstanding
 * and re-arm after each answer. RPC operation lifetime follows the caller and remote reply;
 * connection/setup budgets remain transport-owned, without a separate client response margin.
 */
export const MACHINE_WATCH_WINDOW_MS = 25_000;
