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
): Readonly<{ artifacts: Record<string, DecryptedArtifact>; storageChanged: boolean; changedIds: readonly string[] }> {
  let next = previous;
  let storageChanged = false;
  const changedIds = new Set<string>();
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
    changedIds.add(artifact.id);
  }
  return { artifacts: next, storageChanged, changedIds: [...changedIds] };
}

function skillRevision(artifact: DecryptedArtifact | undefined): string | undefined {
  return artifact && !artifact.draft && artifact.header?.kind === 'prompt_bundle.v2'
    && artifact.header.bundleSchemaId === 'skills.skill_md_v1'
    ? `${artifact.id}@${artifact.headerVersion}:${artifact.bodyVersion ?? 0}` : undefined;
}

function inventoryUnready(artifact: DecryptedArtifact | undefined): boolean {
  return Boolean(artifact && !artifact.draft
    && (!artifact.isDecrypted || !artifact.rawHeader || artifact.access === undefined));
}

/** Publish the library's exact inputs at the same ingress as the admitted Artifact rows. */
function projectSkillInventory(state: ArtifactsDomain, artifacts: Record<string, DecryptedArtifact>, changedIds: Iterable<string>) {
  let revisions = state.artifactSkillRevisions;
  let unreadyCount = state.artifactInventoryUnreadyCount;
  for (const id of changedIds) {
    const revision = skillRevision(artifacts[id]);
    if (revision !== revisions[id]) {
      if (revisions === state.artifactSkillRevisions) revisions = { ...revisions };
      if (revision === undefined) delete revisions[id]; else revisions[id] = revision;
    }
    unreadyCount += Number(inventoryUnready(artifacts[id])) - Number(inventoryUnready(state.artifacts[id]));
  }
  return { artifactSkillRevisions: revisions, artifactInventoryUnreadyCount: unreadyCount };
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  /** Content revisions only; unrelated Artifacts and body hydration retain this identity. */
  artifactSkillRevisions: Record<string, string>;
  /** Visible rows whose membership/access cannot yet establish a complete library inventory. */
  artifactInventoryUnreadyCount: number;
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
    artifactSkillRevisions: {},
    artifactInventoryUnreadyCount: 0,
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
        const changedIds = new Set(merged.changedIds);
        if (inventoryReadStartedWith) {
          const members = new Set(artifacts.map(artifact => artifact.id));
          for (const [id, artifact] of Object.entries(state.artifacts)) {
            if (members.has(id) || artifact !== inventoryReadStartedWith[id]) continue;
            if (reconciled === state.artifacts) reconciled = { ...reconciled };
            delete reconciled[id];
            changedIds.add(id);
            removed = true;
          }
        }
        const loaded = state.artifactsLoaded || inventoryReadStartedWith !== undefined;
        if (reconciled === state.artifacts && loaded === state.artifactsLoaded) return state;
        return {
          ...state,
          artifacts: reconciled,
          ...projectSkillInventory(state, reconciled, changedIds),
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
          ...projectSkillInventory(state, updated.artifacts, updated.changedIds),
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
          ...projectSkillInventory(state, updated.artifacts, updated.changedIds),
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
          ...projectSkillInventory(state, remainingArtifacts, [artifactId]),
          artifactsStorageRevision: state.artifactsStorageRevision + 1,
        };
      }),
  };
}
