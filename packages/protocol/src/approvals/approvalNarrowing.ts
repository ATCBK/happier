import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../json/strictJsonValue.js';

/** Input admission only: this never decides whether an Action needs approval. */
export type ApprovalNarrowing = Readonly<{
  narrow(original: unknown, chosen: unknown): unknown | null;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function omit(value: Readonly<Record<string, unknown>>, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

/** A person may keep fewer items, refresh expectations, and drop named true flags. */
export function subsetNarrowing(options: Readonly<{
  path: string;
  key: (item: Readonly<Record<string, unknown>>) => string;
  refreshable?: readonly string[];
  reducible?: readonly string[];
}>): ApprovalNarrowing {
  const refreshable = options.refreshable ?? [];
  const reducible = options.reducible ?? [];
  return {
    narrow(original, chosen) {
      let source: Readonly<Record<string, unknown>> | null;
      let selection: Readonly<Record<string, unknown>> | null;
      try {
        source = record(projectNativeJsonValueForTransport(original));
        selection = record(projectNativeJsonValueForTransport(chosen));
      } catch {
        return null;
      }
      if (!source || !selection) return null;
      const originalItems = source[options.path];
      const chosenItems = selection[options.path];
      if (!Array.isArray(originalItems) || !Array.isArray(chosenItems) || chosenItems.length === 0) return null;
      if (!sameStrictJsonValue(omit(source, [options.path, ...reducible]), omit(selection, [options.path, ...reducible]))) return null;
      for (const flag of reducible) {
        if (sameStrictJsonValue(source[flag], selection[flag])) continue;
        if (source[flag] !== true || (selection[flag] !== false && selection[flag] !== undefined)) return null;
      }
      const byKey = new Map<string, unknown>();
      for (const value of originalItems) {
        const item = typeof value === 'string' ? value : record(value);
        if (item === null) return null;
        const key = typeof item === 'string' ? item : options.key(item);
        if (byKey.has(key)) return null;
        byKey.set(key, item);
      }
      const selected = new Set<string>();
      for (const value of chosenItems) {
        const item = typeof value === 'string' ? value : record(value);
        if (item === null) return null;
        const key = typeof item === 'string' ? item : options.key(item);
        const admitted = byKey.get(key);
        const admittedRecord = record(admitted);
        const candidateRecord = record(item);
        const unchanged = admittedRecord && candidateRecord
          ? sameStrictJsonValue(omit(admittedRecord, refreshable), omit(candidateRecord, refreshable))
          : sameStrictJsonValue(admitted, item);
        if (!byKey.has(key) || selected.has(key) || !unchanged) return null;
        selected.add(key);
      }
      return selection;
    },
  };
}
