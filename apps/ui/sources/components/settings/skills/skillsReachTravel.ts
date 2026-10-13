/**
 * Which reach dots just arrived (P5 `travel`): skills that newly reach a machine travel out from the
 * planet once. The first drawn map is the baseline (`seen` null), so nothing moves on arrival.
 */
export function arrivedReachDots(
  seen: ReadonlySet<string> | null,
  bodies: readonly Readonly<{ dots: readonly Readonly<{ key: string }>[] }>[],
): Readonly<{ seen: ReadonlySet<string>; arrived: readonly string[] }> {
  const now = new Set(bodies.flatMap((body) => body.dots.map((dot) => dot.key)));
  return { seen: now, arrived: seen === null ? [] : [...now].filter((key) => !seen.has(key)) };
}
