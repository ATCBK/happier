/**
 * Idle lifetime advertised and enforced by Happier's Fastify HTTP server.
 * Fastify 5.12.7 inherits Node's 72-second default; the server sets the value
 * explicitly so clients can retire pooled sockets before this boundary.
 */
export const SERVER_HTTP_KEEP_ALIVE_TIMEOUT_MS_V1 = 72_000;
