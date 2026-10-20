/**
 * Where a reader was in a Doc when a passage sent them to its thread, so Back lands on the same passage
 * (lab K1-Ap/Rp). In memory for this app run only; a Doc opened any other way starts at the top.
 */
const lastOffset = new Map<string, number>();
const returning = new Map<string, number>();

export function trackDocScroll(artifactId: string, offset: number): void {
  lastOffset.set(artifactId, offset);
}

/** A passage is about to open its thread: Back should come back to this offset. */
export function rememberDocReturn(artifactId: string): void {
  returning.set(artifactId, lastOffset.get(artifactId) ?? 0);
}

/** The offset to restore when the Doc is shown again after its thread (read during render). */
export function peekDocReturn(artifactId: string): number | null {
  return returning.get(artifactId) ?? null;
}

/** The Doc is showing again: the return has been used. */
export function clearDocReturn(artifactId: string): void {
  returning.delete(artifactId);
}
