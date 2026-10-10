import {
  PromptBundleBodyV1Schema,
  PromptBundleSchemaIdV1Schema,
  projectPromptBundleActionEntriesV1,
  type PromptBundleBodyV1,
  type PromptBundleCreateActionInputV1,
  type PromptBundleEntryV1,
  type PromptBundleUpdateActionInputV1,
} from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import {
  type PromptLibraryStoredArtifact,
} from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import { ArtifactOrganizationMutationFailureV1, ArtifactOrganizationMutationFailureDetailsV1Schema, readArtifactOrganizationV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { PromptDocRevisionV1Schema } from '@happier-dev/protocol/prompts/library/promptDocV2';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { encodeBase64, decodeBase64 } from '@/encryption/base64';
import type { MountedAuthoringActionExecute } from '@/sync/ops/actions/sessionAuthoringActions';
import { withUiPromptLibraryArtifactStore } from './promptLibraryArtifactStore';

type PromptBundleActionOptions = Readonly<{
  serverId?: string | null;
  expectedAccountId?: string;
  signal?: AbortSignal;
  executeAction?: MountedAuthoringActionExecute;
}>;

function readPromptBundleActionOutput(result: ActionExecuteResult): unknown {
  if (!result.ok) {
    if (result.errorCode === 'artifact_organization_failed') {
      const details = ArtifactOrganizationMutationFailureDetailsV1Schema.safeParse(result.details);
      if (details.success) throw new ArtifactOrganizationMutationFailureV1(details.data);
    }
    throw Object.assign(new Error(result.error), { code: result.errorCode, result });
  }
  return result.result;
}

export const DEFAULT_SKILL_PROMPT_MARKDOWN = `---
name: skill
description: Describe when this skill should be used.
---

## When to use
- Explain the situations where this skill applies.

## Instructions
1. Add the exact steps this skill should follow.
`;

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return encodeBase64(bytes, 'base64');
}

function decodeUtf8Base64(value: string): string {
  const bytes = decodeBase64(value);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function upsertPromptBundleEntry(
  entries: PromptBundleEntryV1[],
  nextEntry: PromptBundleEntryV1,
): PromptBundleEntryV1[] {
  const next = entries.slice();
  const idx = next.findIndex((e) => e.path === nextEntry.path);
  if (idx >= 0) {
    next[idx] = { ...next[idx], ...nextEntry };
    return next;
  }
  return [...next, nextEntry];
}

function upsertSkillMdEntry(
  entries: PromptBundleEntryV1[],
  content: string,
): PromptBundleEntryV1[] {
  const encoded = encodeUtf8Base64(content);
  const entry: PromptBundleEntryV1 = {
    path: 'SKILL.md',
    contentBase64: encoded,
    contentKind: 'utf8',
  };
  const withoutSkillMd = entries.filter((item) => item.path !== 'SKILL.md');
  return [entry, ...withoutSkillMd];
}

export function listPromptBundleSupportingEntries(
  body: PromptBundleBodyV1,
): PromptBundleEntryV1[] {
  return body.entries
    .filter((entry) => entry.path !== 'SKILL.md')
    .slice()
    .sort((left, right) =>
      left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }),
    );
}

export function readPromptBundleUtf8Entry(
  body: PromptBundleBodyV1,
  path: string,
): string | null {
  const entry = body.entries.find((item) => item.path === path);
  if (!entry || entry.contentKind !== 'utf8') return null;
  try {
    return decodeUtf8Base64(entry.contentBase64);
  } catch {
    return null;
  }
}

export function upsertPromptBundleUtf8Entry(
  entries: PromptBundleEntryV1[],
  params: Readonly<{ path: string; content: string }>,
): PromptBundleEntryV1[] {
  return upsertPromptBundleEntry(entries, {
    path: params.path,
    contentBase64: encodeUtf8Base64(params.content),
    contentKind: 'utf8',
  });
}

export function removePromptBundleEntry(
  entries: PromptBundleEntryV1[],
  path: string,
): PromptBundleEntryV1[] {
  return entries.filter((entry) => entry.path !== path);
}

function readPromptBundleArtifactTitle(
  artifact: { header?: Readonly<Record<string, unknown>> | null } | null,
): string {
  const headerTitle =
    typeof artifact?.header?.title === 'string' ? artifact.header.title : null;
  if (headerTitle && headerTitle.trim().length > 0) return headerTitle;
  return '';
}

export function readSkillMarkdownFromPromptBundleBody(
  body: PromptBundleBodyV1,
): string | null {
  const entry = body.entries.find((e) => e.path === 'SKILL.md');
  if (!entry) return null;
  if (entry.contentKind !== 'utf8') return null;
  try {
    return decodeUtf8Base64(entry.contentBase64);
  } catch {
    return null;
  }
}

export function hasSkillPromptMarkdownContent(value: string): boolean {
  return value.trim().length > 0;
}

function normalizeNewSkillPromptMarkdown(value: string): string {
  return hasSkillPromptMarkdownContent(value)
    ? value
    : DEFAULT_SKILL_PROMPT_MARKDOWN;
}

export async function createPromptBundleArtifact(
  params: PromptBundleCreateActionInputV1 & PromptBundleActionOptions,
): Promise<string> {
  const { serverId, expectedAccountId, signal, executeAction, ...request } = params;
  const result = executeAction ? await executeAction('prompt_bundle.create', request, { signal })
    : await (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor().execute('prompt_bundle.create', request,
      { surface: 'ui', serverId: serverId ?? undefined, expectedAccountId, signal });
  const output = readPromptBundleActionOutput(result);
  if (!output || typeof output !== 'object' || !('ok' in output) || output.ok !== true
    || !('artifactId' in output) || typeof output.artifactId !== 'string') {
    throw Object.assign(new Error('action_not_completed'), { code: 'action_not_completed', result });
  }
  return output.artifactId;
}

export async function createSkillPromptBundle(
  params: Omit<PromptBundleCreateActionInputV1, 'bundleSchemaId' | 'entries'> & Readonly<{
    skillMarkdown: string;
  }> & PromptBundleActionOptions,
): Promise<string> {
  const { skillMarkdown, ...request } = params;
  return await createPromptBundleArtifact({
    ...request,
    bundleSchemaId: 'skills.skill_md_v1',
    entries: upsertSkillMdEntry(
      [],
      normalizeNewSkillPromptMarkdown(skillMarkdown),
    ),
    folderId: params.folderId ?? null,
    tags: params.tags ?? [],
  });
}

async function updatePromptBundleArtifact(
  params: PromptBundleUpdateActionInputV1 & PromptBundleActionOptions,
): Promise<PromptLibraryStoredArtifact['revision']> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');
  const { serverId, expectedAccountId, signal, executeAction, ...request } = params;
  const result = executeAction ? await executeAction('prompt_bundle.update', { ...request, artifactId }, { signal })
    : await (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor().execute('prompt_bundle.update', { ...request, artifactId },
      { surface: 'ui', serverId: serverId ?? undefined, expectedAccountId, signal });
  const output = readPromptBundleActionOutput(result);
  const revision = output && typeof output === 'object' && 'revision' in output
    ? PromptDocRevisionV1Schema.safeParse(output.revision) : null;
  if (!revision?.success) throw new Error('prompt_bundle_update_receipt_unavailable');
  return revision.data;
}

export async function updateSkillPromptBundle(
  params: Extract<PromptBundleUpdateActionInputV1, { skillMarkdown: string }> & PromptBundleActionOptions,
): Promise<PromptLibraryStoredArtifact['revision']> {
  return updatePromptBundleArtifact(params);
}

export async function duplicatePromptBundle(
  artifactId: string,
  options?: PromptBundleActionOptions,
): Promise<string> {
  return withUiPromptLibraryArtifactStore(async (store, account) => {
    const existing = await store.read(artifactId, { signal: options?.signal });
    if (existing?.header?.kind !== 'prompt_bundle.v2')
      throw new Error('prompt_bundle_invalid_kind');
    if (typeof existing.body !== 'string')
      throw new Error('prompt_bundle_missing_body');
    const bodyRaw = existing.body;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

    const baseTitle =
      typeof existing?.header?.title === 'string' ? existing.header.title : '';
    if (!store.organization) throw Object.assign(new Error('artifact_organization_unavailable'), { code: 'artifact_organization_unavailable' });
    const organization = await readArtifactOrganizationV1({ port: store.organization, artifactId, signal: options?.signal });
    if (organization.status !== 'ready') throw Object.assign(new Error(organization.reason), { code: organization.reason });

    return await createPromptBundleArtifact(
      {
        title: `${baseTitle || 'Skill'} Copy`,
        bundleSchemaId: PromptBundleSchemaIdV1Schema.parse(existing.header.bundleSchemaId),
        entries: projectPromptBundleActionEntriesV1(parsed.data.entries),
        folderId: organization.header.folderId ?? null,
        tags: organization.header.tags ?? [],
        serverId: account.serverId,
        expectedAccountId: account.accountId,
        signal: options?.signal,
        executeAction: options?.executeAction ?? (async (actionId, request, execution) => {
          const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
          return executeDefaultActionInCapturedAccount(account, actionId, request, {
            surface: 'ui', serverId: account.serverId, expectedAccountId: account.accountId, signal: execution?.signal,
          });
        }),
      },
    );
  }, options);
}

export async function updateSkillPromptBundleWithEntry(
  params: Readonly<{
    artifactId: string;
    path: string;
    content: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
  }> & PromptBundleActionOptions,
): Promise<PromptLibraryStoredArtifact['revision']> {
  return mutatePromptBundleEntries(params, entries => upsertPromptBundleUtf8Entry(entries, {
    path: params.path, content: params.content,
  }));
}

export async function removeSkillPromptBundleEntry(
  params: Readonly<{
    artifactId: string;
    path: string;
    expectedRevision?: PromptLibraryStoredArtifact['revision'];
  }> & PromptBundleActionOptions,
): Promise<PromptLibraryStoredArtifact['revision']> {
  return mutatePromptBundleEntries(params, entries => removePromptBundleEntry(entries, params.path));
}

async function mutatePromptBundleEntries(
  params: Readonly<{ artifactId: string; expectedRevision?: PromptLibraryStoredArtifact['revision'] }> & PromptBundleActionOptions,
  change: (entries: PromptBundleEntryV1[]) => PromptBundleEntryV1[],
): Promise<PromptLibraryStoredArtifact['revision']> {
  const artifactId = String(params.artifactId ?? '').trim();
  if (!artifactId) throw new Error('invalid_artifact_id');
  return withUiPromptLibraryArtifactStore(async (store, account) => {
    const artifact = await store.read(artifactId, { signal: params.signal });
    if (artifact?.header?.kind !== 'prompt_bundle.v2')
      throw new Error('prompt_bundle_invalid_kind');
    if (typeof artifact?.body !== 'string')
      throw new Error('prompt_bundle_missing_body');
    const bodyRaw = artifact.body;
    const parsed = PromptBundleBodyV1Schema.safeParse(JSON.parse(bodyRaw));
    if (!parsed.success) throw new Error('prompt_bundle_invalid_body');

    return updatePromptBundleArtifact({
      artifactId,
      title: readPromptBundleArtifactTitle(artifact),
      entries: projectPromptBundleActionEntriesV1(change(parsed.data.entries)),
      expectedRevision: params.expectedRevision ?? artifact.revision,
      serverId: account.serverId,
      expectedAccountId: account.accountId,
      signal: params.signal,
      executeAction: params.executeAction ?? (async (actionId, request, execution) => {
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        return executeDefaultActionInCapturedAccount(account, actionId, request, {
          surface: 'ui', serverId: account.serverId, expectedAccountId: account.accountId, signal: execution?.signal,
        });
      }),
    });
  }, params);
}
