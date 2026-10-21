/** One initial input identity for Pending admission and profile publication. */
export function resolveExecutionRunInitialInputLocalId(runId: string, localInputId?: string): string {
  return localInputId ?? `execution-run-initial:${runId}`;
}
