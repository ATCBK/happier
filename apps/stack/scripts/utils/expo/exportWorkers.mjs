// One argument policy for Expo and the admission owner that reserves its tree.
export function resolveExpoExportWorkers(args, env, { interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY) } = {}) {
  // Expo's scalar argument parser uses the last occurrence.
  const flagIndex = args.findLastIndex(arg => arg === '--max-workers' || (typeof arg === 'string' && arg.startsWith('--max-workers=')));
  if (flagIndex !== -1) {
    const flag = args[flagIndex];
    const raw = flag === '--max-workers' ? args[flagIndex + 1] : flag.slice('--max-workers='.length);
    const value = Number(raw);
    return { explicit: true, workers: Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : null };
  }
  const rawOverride = String(env?.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS ?? '').trim();
  if (rawOverride) {
    const value = Number(rawOverride);
    return { explicit: true, workers: Number.isFinite(value) && Math.floor(value) > 0 ? Math.floor(value) : null };
  }
  const rawBudget = String(env?.GOMAXPROCS ?? '').trim();
  const budget = Number(rawBudget);
  return { explicit: false, workers: !interactive && /^\d+$/.test(rawBudget) && Number.isSafeInteger(budget) && budget > 0 ? budget : null };
}

export function applyExpoExportMaxWorkersArgs(args, env) {
  const next = Array.isArray(args) ? [...args] : [];
  if (next[0] !== 'export') return next;
  if (next.some(arg => arg === '--max-workers' || (typeof arg === 'string' && arg.startsWith('--max-workers=')))) return next;
  const { workers } = resolveExpoExportWorkers(next, env);
  if (workers !== null) next.push('--max-workers', String(workers));
  return next;
}
