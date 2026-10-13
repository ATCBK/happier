export type OpenCodeConfigPart = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function readOpenCodeConfigPart(content: string): OpenCodeConfigPart {
  const parsed: unknown = JSON.parse(content);
  if (!isObject(parsed)) throw new Error('OpenCode config content must be a JSON object');
  return parsed;
}

function mergeValue(previous: unknown, next: unknown, orderedPermissions = false): unknown {
  if (Array.isArray(previous) && Array.isArray(next)) {
    return [...previous, ...next];
  }
  if (isObject(previous) && isObject(next)) {
    return Object.fromEntries([
      ...Object.entries(previous).filter(([key]) => !orderedPermissions || !Object.prototype.hasOwnProperty.call(next, key)),
      ...Object.entries(next).map(([key, value]) => [key, mergeValue(previous[key], value, orderedPermissions)]),
    ]);
  }
  return next;
}

/** Later parts override scalar values; object fields and array entries survive. */
export function mergeOpenCodeConfigContent(parts: readonly OpenCodeConfigPart[]): string {
  return JSON.stringify(parts.reduce<OpenCodeConfigPart>((merged, part) => {
    if (!isObject(part)) throw new Error('OpenCode config content must be a JSON object');
    return Object.fromEntries([
      ...Object.entries(merged),
      ...Object.entries(part).map(([key, value]) => [key, mergeValue(merged[key], value, key === 'permission')]),
    ]);
  }, {}));
}
