import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoreGet, StoreSet } from './_shared';

function retainArtifactSlices(previous: DecryptedArtifact | undefined, incoming: DecryptedArtifact): DecryptedArtifact {
  if (!previous?.isDecrypted || !incoming.isDecrypted) return incoming;
  const before = previous;
  let retained = incoming;
  function retainField<Key extends 'header' | 'rawHeader' | 'sessions' | 'body' | 'provenance' | 'storageIdentity'>(key: Key): void {
    const value = before[key];
    if (value === incoming[key] || value === null || typeof value !== 'object'
      || !sameStrictJsonValue(value, incoming[key])) return;
    if (retained === incoming) retained = { ...incoming };
    retained[key] = value;
  }
  for (const key of ['header', 'rawHeader', 'sessions', 'body', 'provenance', 'storageIdentity'] as const) retainField(key);
  return retained;
}

function retainOpenedContent(previous: DecryptedArtifact | undefined, incoming: DecryptedArtifact): DecryptedArtifact {
  if (!previous?.isDecrypted || !incoming.isDecrypted
    || incoming.bodyVersion === undefined || incoming.bodyVersion !== previous.bodyVersion
    || incoming.headerVersion !== previous.headerVersion || incoming.storageMode !== previous.storageMode
    || incoming.access === undefined || incoming.access !== previous.access
    || !incoming.ownerAccountId || incoming.ownerAccountId !== previous.ownerAccountId
    || !sameStrictJsonValue(incoming.rawHeader, previous.rawHeader)) return incoming;

  const sameCustody = incoming.storageMode === 'plain' || (incoming.storageMode === 'e2ee'
    && incoming.storageIdentity !== undefined && previous.storageIdentity !== undefined
    && sameStrictJsonValue(incoming.storageIdentity, previous.storageIdentity));
  if (!sameCustody) return incoming;
  // Omitted attribution was not demanded by this background index. An explicit
  // undefined from a reader that opened it still clears removed private metadata.
  const retainBody = incoming.body === undefined && previous.body !== undefined;
  const retainProvenance = !Object.hasOwn(incoming, 'provenance') && Object.hasOwn(previous, 'provenance');
  if (!retainBody && !retainProvenance) return incoming;
  return { ...incoming, ...(retainBody ? { body: previous.body } : {}),
    ...(retainProvenance ? { provenance: previous.provenance } : {}) };
}

function reconcileArtifacts(
  previous: Record<string, DecryptedArtifact>,
  incoming: readonly DecryptedArtifact[],
): Readonly<{ artifacts: Record<string, DecryptedArtifact>; storageChanged: boolean }> {
  let next = previous;
  let storageChanged = false;
  for (const incomingArtifact of incoming) {
    const before = next[incomingArtifact.id];
    // HTTP body/list reads can finish after a newer socket settlement. Admit
    // revisions here for every writer, so an older snapshot cannot reopen it.
    if (before && (incomingArtifact.headerVersion < before.headerVersion
      || (incomingArtifact.bodyVersion !== undefined && before.bodyVersion !== undefined
        && incomingArtifact.bodyVersion < before.bodyVersion))) continue;
    // Content-only socket events have no grant projection. Only HTTP/grant
    // producers can replace known access; content must neither erase nor grant it.
    const missingKnownAccess = before && (
      (incomingArtifact.access === undefined && before.access !== undefined)
      || (incomingArtifact.ownerAccountId === undefined && before.ownerAccountId !== undefined)
    );
    const withKnownAccess = missingKnownAccess ? {
      ...incomingArtifact,
      ...(before.access !== undefined ? { access: incomingArtifact.access ?? before.access } : {}),
      ...(before.ownerAccountId !== undefined ? { ownerAccountId: incomingArtifact.ownerAccountId ?? before.ownerAccountId } : {}),
    } : incomingArtifact;
    const artifact = retainArtifactSlices(before, retainOpenedContent(before, withKnownAccess));
    if (sameStrictJsonValue(before, artifact)) continue;
    if (!before || before.headerVersion !== artifact.headerVersion || before.bodyVersion !== artifact.bodyVersion
      || before.storageMode !== artifact.storageMode) storageChanged = true;
    if (next === previous) next = { ...previous };
    next[artifact.id] = artifact;
  }
  return { artifacts: next, storageChanged };
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  /** A complete Account inventory was published; targeted body reads do not set this. */
  artifactsLoaded: boolean;
  /** Invalidates the storage projection, not local hydration or grant-only changes. */
  artifactsStorageRevision: number;
  applyArtifacts: (artifacts: DecryptedArtifact[], inventoryReadStartedWith?: Readonly<Record<string, DecryptedArtifact>>) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string) => void;
};

export function createArtifactsDomain<S extends ArtifactsDomain>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    artifactsLoaded: false,
    artifactsStorageRevision: 0,
    applyArtifacts: (artifacts, inventoryReadStartedWith) =>
      set((state) => {
        // The immutable map captured before the read distinguishes a missing
        // inventory member from a socket/create/update that raced that read.
        const admitted = inventoryReadStartedWith ? artifacts.filter(artifact =>
          !(inventoryReadStartedWith[artifact.id] && !state.artifacts[artifact.id])) : artifacts;
        const merged = reconcileArtifacts(state.artifacts, admitted);
        let reconciled = merged.artifacts;
        let removed = false;
        if (inventoryReadStartedWith) {
          const members = new Set(artifacts.map(artifact => artifact.id));
          for (const [id, artifact] of Object.entries(state.artifacts)) {
            if (members.has(id) || artifact !== inventoryReadStartedWith[id]) continue;
            if (reconciled === state.artifacts) reconciled = { ...reconciled };
            delete reconciled[id];
            removed = true;
          }
        }
        const loaded = state.artifactsLoaded || inventoryReadStartedWith !== undefined;
        if (reconciled === state.artifacts && loaded === state.artifactsLoaded) return state;
        return {
          ...state,
          artifacts: reconciled,
          artifactsLoaded: loaded,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(merged.storageChanged || removed),
        };
      }),
    addArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    updateArtifact: (artifact) =>
      set((state) => {
        const updated = reconcileArtifacts(state.artifacts, [artifact]);
        if (updated.artifacts === state.artifacts) return state;
        return {
          ...state,
          artifacts: updated.artifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        if (!Object.prototype.hasOwnProperty.call(state.artifacts, artifactId)) return state;
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
          artifactsStorageRevision: state.artifactsStorageRevision + 1,
        };
      }),
  };
}
