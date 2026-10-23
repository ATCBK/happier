/** Fixed-path completion; Action positional and input grammar stays with its compiler. */
export function resolveCommandPathCompletionCandidates(paths: readonly (readonly string[])[], words: readonly string[]): readonly string[] {
  const prefix = words.at(-1) ?? '';
  const committed = words.length > 0 ? words.slice(0, -1) : [];
  const candidates = new Set<string>();
  for (const path of paths) {
    if (!committed.every((segment, index) => path[index] === segment)) continue;
    const next = path[committed.length];
    if (next?.startsWith(prefix)) candidates.add(next);
  }
  return Object.freeze([...candidates].sort());
}
