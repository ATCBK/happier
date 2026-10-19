import {
  PromptLibraryCatalogKeyV1Schema, PromptLibraryContentV1Schema, StoredPromptLibraryContentV1Schema,
  PromptLibraryRowMutationV1Schema,
  assertPromptLibraryContentForModeV1, buildPromptLibraryPhysicalKeyV1, parsePromptLibraryPhysicalKeyV1,
  PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1, type PromptLibraryContentV1, type PromptLibraryCatalogKeyV1,
} from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { listSavedSecretReferenceCatalogRefsV1 } from '@happier-dev/protocol/account/settings/savedSecretMutationOwner';
import { isDeepStrictEqual } from 'node:util';
import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { validateSavedSecretResourceReferencesInTx } from '@/app/account/savedSecrets/savedSecretResourceService';
import type { Tx } from '@/storage/inTx';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { validateAccountSettingsVersionAtPublicationInTx } from '@/app/accountSettings/writeAccountSettingsInTx';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { listReservedAccountScopedKvRowsInTx, mutateReservedAccountScopedKvRowInTx, readReservedAccountScopedKvRowInTx,
  type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';

export const promptLibraryRowDomain: ReservedAccountScopedKvRowDomain<PromptLibraryContentV1> = {
  label: 'Prompt library catalog',
  parseStoredEnvelope(value) { const parsed = StoredPromptLibraryContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  parseCandidateEnvelope(value) { const parsed = PromptLibraryContentV1Schema.safeParse(value); return parsed.success ? parsed.data : null; },
  assertEnvelopeForMode: assertPromptLibraryContentForModeV1,
};

export function markPromptLibraryRowChangedInTx(tx: Tx, input: Readonly<{ accountId: string; key: PromptLibraryCatalogKeyV1; revision: number }>): ReturnType<typeof markAccountChanged> {
  return markAccountChanged(tx, { accountId: input.accountId, kind: 'account', entityId: buildPromptLibraryPhysicalKeyV1(input.key),
    hint: { promptLibrary: true, key: input.key, revision: input.revision } });
}
export async function readPromptLibraryRowInTx(tx: Tx, input: Readonly<{ accountId: string; key: PromptLibraryCatalogKeyV1 }>) {
  const result = await readReservedAccountScopedKvRowInTx(tx, { ...input, physicalKey: buildPromptLibraryPhysicalKeyV1(input.key), domain: promptLibraryRowDomain });
  if (result.status !== 'present') return result;
  if (result.envelope.t === 'plain' && result.envelope.v.key !== input.key) return { status: 'invalid-stored-content' as const };
  return { status: 'present' as const, revision: result.revision, content: result.envelope };
}
export async function listPromptLibraryRowsInTx(tx: Tx, input: Readonly<{ accountId: string }>) {
  // Unfamiliar stored keys remain untouched, outside this reader's prompt authority.
  // Select before envelope admission so opaque future content cannot poison known rows.
  const result = await listReservedAccountScopedKvRowsInTx(tx, { ...input, physicalPrefix: PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1,
    physicalKeys: PromptLibraryCatalogKeyV1Schema.options.map(buildPromptLibraryPhysicalKeyV1), domain: promptLibraryRowDomain });
  if (result.status !== 'listed') return result;
  const rows: Array<{ key: PromptLibraryCatalogKeyV1; revision: number; content: PromptLibraryContentV1 | null }> = [];
  for (const row of result.rows) {
    const key = parsePromptLibraryPhysicalKeyV1(row.physicalKey);
    if (key === null || (row.envelope?.t === 'plain' && row.envelope.v.key !== key)) return { status: 'invalid-stored-content' as const };
    rows.push({ key, revision: row.revision, content: row.envelope });
  }
  return { status: 'listed' as const, rows };
}
export async function mutatePromptLibraryRowInTx(tx: Tx, input: Readonly<{
  accountId: string; key: PromptLibraryCatalogKeyV1; expectedRevision: number | 'absent'; content: PromptLibraryContentV1 | null;
  sourceSettingsVersion?: number;
  referencedSavedSecretIds?: readonly string[];
  savedSecretRevisions?: readonly Readonly<{ resourceId: string; expectedRevision: number }>[];
  authentication?: TeamOperationAuthenticationContext;
}>) {
  const key = PromptLibraryCatalogKeyV1Schema.parse(input.key);
  if (input.content?.t === 'plain' && input.content.v.key !== key) return { status: 'invalid-stored-content' as const };
  if (input.expectedRevision === 'absent') {
    if (input.sourceSettingsVersion === undefined || input.content === null) throw new Error('Prompt catalog initialization requires captured source currentness');
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, "content");
    if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
    const source = await tx.account.findUniqueOrThrow({ where: { id: input.accountId }, select: { settingsVersion: true } });
    if (source.settingsVersion !== input.sourceSettingsVersion) return { status: 'settings-conflict' as const, revision: source.settingsVersion };
    validateAccountSettingsVersionAtPublicationInTx(tx, { accountId: input.accountId, expectedVersion: input.sourceSettingsVersion });
  } else if (input.sourceSettingsVersion !== undefined) throw new Error('Only catalog initialization admits a source Settings version');
  if (key === 'registry-sources' && input.content !== null) {
    const mutation = PromptLibraryRowMutationV1Schema.parse({ expectedRevision: input.expectedRevision, content: input.content,
      sourceSettingsVersion: input.sourceSettingsVersion, referencedSavedSecretIds: input.referencedSavedSecretIds,
      savedSecretRevisions: input.savedSecretRevisions });
    // The incumbent Account fence covers both reference admission and row CAS.
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, "content");
    if (fence.status === 'account_not_found') return { status: 'account-not-found' as const };
    if (fence.status === 'account_inconsistent') return { status: 'account-inconsistent' as const, reason: fence.reason };
    try { assertPromptLibraryContentForModeV1(input.content, fence.account.currentness.encryptionMode); }
    catch { return { status: 'account-mode-mismatch' as const }; }
    const declaredReferences = mutation.referencedSavedSecretIds ?? [];
    let references: readonly string[];
    try {
      references = input.content.t === 'plain' && input.content.v.key === 'registry-sources'
        ? [...new Set(listSavedSecretReferenceCatalogRefsV1({ profileRecords: [], registrySources: input.content.v.value })
          .map(reference => reference.secretId))] : declaredReferences;
    } catch { return { status: 'invalid-reference' as const }; }
    if (input.content.t === 'plain' && !isDeepStrictEqual([...references].sort(), [...new Set(declaredReferences)].sort())) {
      return { status: 'invalid-reference' as const };
    }
    if (!await validateSavedSecretResourceReferencesInTx(tx, {
      accountId: input.accountId, authentication: input.authentication, references, allowPersonal: true,
      savedSecretRevisions: mutation.savedSecretRevisions ?? [],
    })) return { status: 'invalid-reference' as const };
  }
  return mutateReservedAccountScopedKvRowInTx(tx, { accountId: input.accountId, physicalKey: buildPromptLibraryPhysicalKeyV1(key),
    expectedRevision: input.expectedRevision, envelope: input.content, domain: promptLibraryRowDomain,
    markChanged: ({ tx: changeTx, revision }) => markPromptLibraryRowChangedInTx(changeTx, { accountId: input.accountId, key, revision }) });
}
