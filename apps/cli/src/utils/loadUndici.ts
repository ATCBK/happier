/**
 * Lazy undici for runtime paths that must not pay its load cost at startup.
 *
 * The shipped bundle wraps undici as CommonJS, so a bundled `import('undici')` exposes
 * only `default`; Node source also exposes named exports. `default` carries every export
 * in both shapes, and a named export wins when a runtime provides one.
 */
export async function loadUndici() {
  const namespace = await import('undici');
  return { ...namespace.default, ...namespace };
}
