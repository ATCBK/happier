/**
 * Daemon-owned parking window for machine watches. Mounted clients keep one watch outstanding
 * and re-arm after each answer; their RPC timeout includes this window and the transport margin.
 */
export const MACHINE_WATCH_WINDOW_MS = 25_000;
