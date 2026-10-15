/** Relative change for like Usage quantities; an empty/unknown base cannot support a percentage. */
export function usageComparison(current: number | null, previous: number | null): Readonly<{ value: string; delta: number }> | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)
    || current < 0 || previous <= 0) return null;
  const ratio = current / previous;
  if (!Number.isFinite(ratio)) return null;
  const delta = ratio - 1;
  // At twice the base, whole multiples describe the scale directly. Below it,
  // percentages keep small changes and decreases comparable without a guessed minimum base.
  const magnitude = ratio >= 2
    ? `${ratio.toLocaleString(undefined, { maximumFractionDigits: 1 })}×`
    : `${Math.round(Math.abs(delta) * 100)}%`;
  return { value: `${delta >= 0 ? '▲' : '▼'} ${magnitude}`, delta };
}
