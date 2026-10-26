import type { DecryptedArtifact } from '../../domains/artifacts/artifactTypes';
import type { ArtifactInventoryPublication, ArtifactInventorySelection } from '../../domains/artifacts/artifactInventory';
import { doesArtifactInventorySelectionMatchHeader, isApprovalSessionInventorySelection, isApprovalStateInventorySelection } from '../../domains/artifacts/artifactInventory';
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { StoreGet, StoreSet } from './_shared';
import type { ServerAccountScope } from '../../domains/scope/serverAccountScope';
import { reconcileFailedApprovalDismissals, retireFailedApprovalDismissals } from '../../domains/state/failedApprovalUiState';

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
    || incoming.access === undefined || (previous.access !== undefined && incoming.access !== previous.access)
    || !incoming.ownerAccountId || (previous.ownerAccountId !== undefined && incoming.ownerAccountId !== previous.ownerAccountId)
    || !sameStrictJsonValue(incoming.rawHeader, previous.rawHeader)) return incoming;

  const sameCustody = incoming.storageMode === 'plain' || (incoming.storageMode === 'e2ee'
    && incoming.storageIdentity !== undefined && previous.storageIdentity !== undefined
    && incoming.storageIdentity.contentKeyEnvelope === previous.storageIdentity.contentKeyEnvelope
    && incoming.storageIdentity.provenanceKeyEnvelope === previous.storageIdentity.provenanceKeyEnvelope);
  if (!sameCustody) return incoming;
  // Omitted attribution was not demanded by this background index. An explicit
  // undefined from a reader that opened it still clears removed private metadata.
  const retainBody = incoming.body === undefined && previous.body !== undefined;
  // First HTTP grant enrichment confirms body access, not omitted private attribution.
  // Known grant changes still invalidate all retained content above.
  const retainProvenance = incoming.access === previous.access && incoming.ownerAccountId === previous.ownerAccountId
    && !Object.hasOwn(incoming, 'provenance') && Object.hasOwn(previous, 'provenance');
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
  if (!artifact || artifact.draft) return false;
  const kind = artifact.rawHeader?.kind ?? artifact.header?.kind ?? artifact.kindHint;
  // A known other kind cannot change Skills membership. Unknown opaque rows
  // may be bundles and keep the library's currentness check conservative.
  return (typeof kind !== 'string' || kind === 'prompt_bundle.v2')
    && (!artifact.isDecrypted || !artifact.rawHeader || artifact.access === undefined);
}

/** Missing opaque classification cannot establish whether a retained row belongs to the browser. */
function browserMembership(artifact: DecryptedArtifact): boolean | null {
  const header = artifact.rawHeader ?? artifact.header;
  if (header) return getArtifactKindPolicyV1(header.kind).browserListed;
  return Object.hasOwn(artifact, 'kindHint') && artifact.kindHint !== undefined
    ? getArtifactKindPolicyV1(artifact.kindHint).browserListed : null;
}

function browserUnready(artifact: DecryptedArtifact | undefined): boolean {
  return artifact !== undefined && browserMembership(artifact) !== false
    && (!artifact.isDecrypted || !artifact.rawHeader);
}

function isOpenWorkflowPublicationCandidate(artifact: DecryptedArtifact | undefined): boolean {
  return artifact?.isDecrypted === true && !artifact.draft
    && (artifact.header?.kind === APPROVAL_ARTIFACT_KINDS_V1.builtIn || artifact.header?.kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction)
    && artifact.header.approvalStatus === 'open';
}

/** Publish narrow inventory inputs at the same ingress as the admitted Artifact rows. */
function projectArtifactInventory(state: ArtifactsDomain, artifacts: Record<string, DecryptedArtifact>, changedIds: Iterable<string>) {
  let revisions = state.artifactSkillRevisions;
  let unreadyCount = state.artifactInventoryUnreadyCount;
  let browserLoaded = state.artifactBrowserLoaded;
  let publications = state.artifactOpenWorkflowPublicationArtifacts;
  for (const id of changedIds) {
    const artifact = artifacts[id];
    // This is discovery membership only. The approval owner admits matching
    // header/body revisions before a publication can be associated with a Run.
    const candidate = artifact && isOpenWorkflowPublicationCandidate(artifact) ? artifact : null;
    const before = state.artifacts[id];
    const wasCandidate = isOpenWorkflowPublicationCandidate(before);
    if (candidate !== null || wasCandidate) {
      if (!candidate || before?.header !== candidate.header || before?.body !== candidate.body
        || before?.isDecrypted !== candidate.isDecrypted || before?.draft !== candidate.draft) {
        publications = candidate ? wasCandidate
          ? publications.map(entry => entry.id === id ? candidate : entry)
          : [...publications, candidate]
          : publications.filter(entry => entry.id !== id);
      }
    }
    const revision = skillRevision(artifacts[id]);
    if (revision !== revisions[id]) {
      if (revisions === state.artifactSkillRevisions) revisions = { ...revisions };
      if (revision === undefined) delete revisions[id]; else revisions[id] = revision;
    }
    unreadyCount += Number(inventoryUnready(artifacts[id])) - Number(inventoryUnready(state.artifacts[id]));
    if (browserLoaded && browserUnready(artifacts[id])) browserLoaded = false;
  }
  return { artifactSkillRevisions: revisions, artifactInventoryUnreadyCount: unreadyCount, artifactBrowserLoaded: browserLoaded,
    artifactOpenWorkflowPublicationArtifacts: publications };
}

export type ArtifactsDomain = {
  artifacts: Record<string, DecryptedArtifact>;
  /** Open Run-request candidates, maintained only from changed Artifact ids at ingress. */
  artifactOpenWorkflowPublicationArtifacts: readonly DecryptedArtifact[];
  /** Content revisions only; unrelated Artifacts and body hydration retain this identity. */
  artifactSkillRevisions: Record<string, string>;
  /** Potential Skill bundles (including unknown rows) whose membership/access is not yet readable. */
  artifactInventoryUnreadyCount: number;
  /** A complete Account inventory was published; targeted body reads do not set this. */
  artifactsLoaded: boolean;
  /** Exhausted readable browser membership; never certifies private kinds or full Account membership. */
  artifactBrowserLoaded: boolean;
  /** Open approval membership and notice membership; never certifies settled approvals. */
  artifactInboxLoaded: boolean;
  artifactInboxPartial: boolean;
  /** Exact header memberships completed by the same inventory owner; never implies full membership. */
  artifactInventoryKindsLoaded: readonly string[];
  /** Exhausted scoped reads with locked structural rows: renderable, never complete classification. */
  artifactInventoryKindsPartial: readonly string[];
  /** Invalidates the storage projection, not local hydration or grant-only changes. */
  artifactsStorageRevision: number;
  applyArtifacts: (artifacts: DecryptedArtifact[], inventoryReadStartedWith?: Readonly<Record<string, DecryptedArtifact>>,
    inventorySelection?: ArtifactInventorySelection, publication?: ArtifactInventoryPublication) => void;
  addArtifact: (artifact: DecryptedArtifact) => void;
  updateArtifact: (artifact: DecryptedArtifact) => void;
  deleteArtifact: (artifactId: string) => void;
};

export function createArtifactsDomain<S extends ArtifactsDomain & { profileScope?: ServerAccountScope | null }>({
  set,
}: {
  set: StoreSet<S>;
  get: StoreGet<S>;
}): ArtifactsDomain {
  return {
    artifacts: {},
    artifactOpenWorkflowPublicationArtifacts: [],
    artifactSkillRevisions: {},
    artifactInventoryUnreadyCount: 0,
    artifactsLoaded: false,
    artifactBrowserLoaded: false,
    artifactInboxLoaded: false,
    artifactInboxPartial: false,
    artifactInventoryKindsLoaded: [],
    artifactInventoryKindsPartial: [],
    artifactsStorageRevision: 0,
    applyArtifacts: (artifacts, inventoryReadStartedWith, inventorySelection, publication = 'inventory') =>
      set((state) => {
        const inventoryKinds = typeof inventorySelection === 'string' || isApprovalSessionInventorySelection(inventorySelection)
          || isApprovalStateInventorySelection(inventorySelection) ? undefined : inventorySelection;
        // The immutable map captured before the read distinguishes a missing
        // inventory member from a socket/create/update that raced that read.
        const admitted = inventoryReadStartedWith ? artifacts.filter(artifact =>
          !(inventoryReadStartedWith[artifact.id] && !state.artifacts[artifact.id])) : artifacts;
        const merged = reconcileArtifacts(state.artifacts, admitted);
        let reconciled = merged.artifacts;
        let removed = false;
        const retiredIds: string[] = [];
        const changedIds = new Set(merged.changedIds);
        const complete = inventoryReadStartedWith !== undefined && publication === 'inventory';
        const exhausted = inventoryReadStartedWith !== undefined && publication !== 'partial';
        const members = inventoryReadStartedWith && exhausted ? new Set(artifacts.map(artifact => artifact.id)) : null;
        const observesBrowser = inventorySelection === undefined || inventorySelection === 'browserListed';
        let browserOpaqueSurvivor = false;
        if (inventoryReadStartedWith && members) {
          for (const [id, artifact] of Object.entries(state.artifacts)) {
            const selected = inventorySelection === 'browserListed' ? browserMembership(artifact) === true
              : doesArtifactInventorySelectionMatchHeader(inventorySelection, artifact.rawHeader ?? artifact.header ?? {});
            if (selected && !members.has(id) && artifact === inventoryReadStartedWith[id]) {
              if (reconciled === state.artifacts) reconciled = { ...reconciled };
              delete reconciled[id];
              retiredIds.push(id);
              changedIds.add(id);
              removed = true;
            } else if (observesBrowser && browserUnready(reconciled[id])) {
              // Retained unresolved rows remain visible in the shared browser
              // projection, so their counts cannot be certified as complete.
              browserOpaqueSurvivor = true;
            }
          }
        }
        if (complete && members && inventorySelection === undefined) {
          reconcileFailedApprovalDismissals(state.profileScope, id => members.has(id) || Object.hasOwn(reconciled, id));
        } else if (complete && retiredIds.length > 0) retireFailedApprovalDismissals(state.profileScope, retiredIds);
        const loaded = state.artifactsLoaded || (complete && inventorySelection === undefined);
        const inboxLoaded = inventorySelection === 'inboxOpen' && exhausted
          ? complete : state.artifactInboxLoaded;
        const inboxPartial = inventorySelection === 'inboxOpen' && exhausted
          ? !complete : state.artifactInboxPartial;
        const projected = projectArtifactInventory(state, reconciled, changedIds);
        let browserLoaded = projected.artifactBrowserLoaded;
        if (inventoryReadStartedWith && observesBrowser) {
          if (publication === 'unreadable') browserLoaded = false;
          else if (complete) browserLoaded = artifacts.every(artifact => artifact.isDecrypted && artifact.rawHeader)
            && !browserOpaqueSurvivor;
        }
        const previousKinds = state.artifactInventoryKindsLoaded;
        const opaqueKinds = inventoryReadStartedWith !== undefined && publication === 'unreadable' ? inventoryKinds : undefined;
        const loadedKinds = complete && inventoryKinds?.some(kind => !previousKinds.includes(kind))
          ? [...new Set([...previousKinds, ...inventoryKinds])].sort() : previousKinds;
        const classifiedKinds = opaqueKinds && previousKinds.some(kind => opaqueKinds.includes(kind))
          ? loadedKinds.filter(kind => !opaqueKinds.includes(kind)) : loadedKinds;
        const previousPartial = state.artifactInventoryKindsPartial;
        const partialKinds = opaqueKinds && opaqueKinds.some(kind => !previousPartial.includes(kind))
          ? [...new Set([...previousPartial, ...opaqueKinds])].sort()
          : complete && inventoryKinds && previousPartial.some(kind => inventoryKinds.includes(kind))
            ? previousPartial.filter(kind => !inventoryKinds.includes(kind)) : previousPartial;
        if (reconciled === state.artifacts && loaded === state.artifactsLoaded && browserLoaded === state.artifactBrowserLoaded
          && inboxLoaded === state.artifactInboxLoaded && inboxPartial === state.artifactInboxPartial && classifiedKinds === previousKinds
          && partialKinds === previousPartial) return state;
        return {
          ...state,
          artifacts: reconciled,
          ...projected,
          artifactsLoaded: loaded,
          artifactBrowserLoaded: browserLoaded,
          artifactInboxLoaded: inboxLoaded,
          artifactInboxPartial: inboxPartial,
          artifactInventoryKindsLoaded: classifiedKinds,
          artifactInventoryKindsPartial: partialKinds,
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
          ...projectArtifactInventory(state, updated.artifacts, updated.changedIds),
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
          ...projectArtifactInventory(state, updated.artifacts, updated.changedIds),
          artifactsStorageRevision: state.artifactsStorageRevision + Number(updated.storageChanged),
        };
      }),
    deleteArtifact: (artifactId) =>
      set((state) => {
        retireFailedApprovalDismissals(state.profileScope, [artifactId]);
        if (!Object.prototype.hasOwnProperty.call(state.artifacts, artifactId)) return state;
        const { [artifactId]: _, ...remainingArtifacts } = state.artifacts;

        return {
          ...state,
          artifacts: remainingArtifacts,
          ...projectArtifactInventory(state, remainingArtifacts, [artifactId]),
          artifactsStorageRevision: state.artifactsStorageRevision + 1,
        };
      }),
  };
}
