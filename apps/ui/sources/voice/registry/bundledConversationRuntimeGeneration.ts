type GenerationLease = Readonly<{
  runtimeLeaseId: string;
  signal: AbortSignal;
  runIfCurrent<T>(callback: () => T): T | undefined;
  isCurrent(): boolean;
  canCleanup(): boolean;
  revoke(): void;
}>;

let nextGeneration = 0;
let activeGeneration: number | null = null;
let activeController: AbortController | null = null;
let generationRevision = 0;
const generationListeners = new Set<() => void>();

function publishGenerationChange(): void {
  generationRevision += 1;
  for (const listener of generationListeners) listener();
}

export function getBundledConversationRuntimeGenerationRevision(): number {
  return generationRevision;
}

export function subscribeBundledConversationRuntimeGeneration(listener: () => void): () => void {
  generationListeners.add(listener);
  return () => generationListeners.delete(listener);
}

/** Synchronous ownership lease protecting singleton voice state from late async teardown. */
export function acquireBundledConversationRuntimeGeneration(): GenerationLease {
  const generation = ++nextGeneration;
  const previousController = activeController;
  const controller = new AbortController();
  activeController = controller;
  let revoked = false;
  activeGeneration = generation;
  previousController?.abort();
  publishGenerationChange();
  return Object.freeze({
    runtimeLeaseId: String(generation),
    signal: controller.signal,
    runIfCurrent<T>(callback: () => T): T | undefined {
      return !revoked && activeGeneration === generation ? callback() : undefined;
    },
    isCurrent: () => !revoked && activeGeneration === generation,
    canCleanup: () => activeGeneration === null || activeGeneration === generation,
    revoke() {
      if (revoked) return;
      revoked = true;
      controller.abort();
      if (activeGeneration === generation) {
        activeGeneration = null;
        activeController = null;
        publishGenerationChange();
      }
    },
  });
}

export function resetBundledConversationRuntimeGenerationForTests(): void {
  nextGeneration = 0;
  activeGeneration = null;
  activeController?.abort();
  activeController = null;
  publishGenerationChange();
}
