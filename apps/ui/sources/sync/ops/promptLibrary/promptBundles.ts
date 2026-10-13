import {
  PromptBundleBodyV1Schema,
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
import { decodeSkillRevisionV1, encodeSkillRevisionV1, readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { SKILL_ACTION_OUTPUT_SCHEMAS_V1, SkillInstallAcknowledgedEffectsV1Schema,
  type SkillInstallAcknowledgedEffectsV1, type SkillLibraryActionIdV1 } from '@happier-dev/protocol/prompts/library/skills/skillActionSchemasV1';
import { ArtifactFolderMutationResultV1Schema } from '@happier-dev/protocol/prompts/library/promptFolderActionSchemasV1';
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

/** An acknowledged content effect is not a retryable draft, even without readable revision data. */
export class SkillAcknowledgedEffectsFailureV1 extends Error {
  constructor(readonly code: string, readonly details: SkillInstallAcknowledgedEffectsV1) {
    super(code); this.name = 'SkillAcknowledgedEffectsFailureV1';
  }
}

function readPromptBundleActionOutput(result: ActionExecuteResult): unknown {
  if (!result.ok) {
    const effects = SkillInstallAcknowledgedEffectsV1Schema.safeParse(result.details);
    if (effects.success && effects.data.skillIds.length > 0)
      throw new SkillAcknowledgedEffectsFailureV1(result.errorCode ?? 'skill_content_acknowledged', effects.data);
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

export async function createSkillPromptBundle(
  params: Omit<PromptBundleCreateActionInputV1, 'bundleSchemaId' | 'entries'> & Readonly<{
    skillMarkdown: string;
  }> & PromptBundleActionOptions,
): Promise<string> {
  const markdown = normalizeNewSkillPromptMarkdown(params.skillMarkdown);
  const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.create'].parse(await executeSkillAction('skills.create', {
    name: readSkillFrontmatterV1(markdown).name ?? params.title,
    files: projectPromptBundleActionEntriesV1(upsertSkillMdEntry([], markdown)),
  }, params));
  await saveSkillOrganization(output.skillId, params, decodeSkillRevisionV1(output.revision));
  return output.skillId;
}

async function executeSkillAction(actionId: SkillLibraryActionIdV1, input: unknown, options: PromptBundleActionOptions) {
  const result = options.executeAction ? await options.executeAction(actionId, input, { signal: options.signal })
    : await (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor().execute(actionId, input,
      { surface: 'ui', authority: 'present_user', serverId: options.serverId ?? undefined,
        expectedAccountId: options.expectedAccountId, signal: options.signal });
  const output = readPromptBundleActionOutput(result);
  if (output && typeof output === 'object' && 'ok' in output && output.ok === false) {
    const code = 'code' in output && typeof output.code === 'string' ? output.code : 'skill_operation_failed';
    throw Object.assign(new Error(code), { code, result });
  }
  return output;
}

async function saveSkillOrganization(artifactId: string, params: Pick<PromptBundleCreateActionInputV1, 'folderId' | 'tags' | 'createFolder'> & PromptBundleActionOptions,
  contentRevision: PromptLibraryStoredArtifact['revision']) {
  if (params.folderId === undefined && params.tags === undefined && params.createFolder === undefined) return;
  await withUiPromptLibraryArtifactStore(async (store, account) => {
    if (!store.organization) throw new Error('artifact_organization_unavailable');
    const execute = params.executeAction ?? (async (actionId, input, options) => {
      const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
      return executeDefaultActionInCapturedAccount(account, actionId, input, { surface: 'ui', authority: 'present_user',
        serverId: account.serverId, expectedAccountId: account.accountId, signal: options?.signal });
    }) satisfies MountedAuthoringActionExecute;
    const requireOrganization = (value: unknown) => {
      const receipt = ArtifactFolderMutationResultV1Schema.parse(value);
      if (receipt.status !== 'updated') throw new ArtifactOrganizationMutationFailureV1({ artifactId, contentRevision, organization: receipt });
    };
    if (params.createFolder) requireOrganization(readPromptBundleActionOutput(await execute('artifact.folders.create', params.createFolder, { signal: params.signal })));
    const read = await readArtifactOrganizationV1({ port: store.organization, artifactId, signal: params.signal });
    if (read.status !== 'ready') throw new ArtifactOrganizationMutationFailureV1({ artifactId, contentRevision,
      organization: { status: 'unavailable', reason: read.reason } });
    requireOrganization(readPromptBundleActionOutput(await execute('artifact.folder.set', { artifactId, expectedRevision: read.revision,
      ...(params.folderId === undefined ? {} : { folderId: params.folderId }), ...(params.tags === undefined ? {} : { tags: params.tags }) }, { signal: params.signal })));
  }, params);
}

export async function updateSkillPromptBundle(
  params: Extract<PromptBundleUpdateActionInputV1, { skillMarkdown: string }> & PromptBundleActionOptions,
): Promise<PromptLibraryStoredArtifact['revision']> {
  if (!params.expectedRevision) {
    return withUiPromptLibraryArtifactStore(async (store, account) => {
      const artifact = await store.read(params.artifactId, { signal: params.signal });
      if (!artifact || artifact.header?.kind !== 'prompt_bundle.v2') throw new Error('prompt_bundle_invalid_kind');
      return updateSkillPromptBundle({ ...params, expectedRevision: artifact.revision,
        serverId: account.serverId, expectedAccountId: account.accountId,
        executeAction: params.executeAction ?? (async (actionId, input, options) => {
          const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
          return executeDefaultActionInCapturedAccount(account, actionId, input, { surface: 'ui', authority: 'present_user',
            serverId: account.serverId, expectedAccountId: account.accountId, signal: options?.signal });
        }),
      });
    }, params);
  }
  const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.update'].parse(await executeSkillAction('skills.update', {
    skillId: params.artifactId, expectedRevision: encodeSkillRevisionV1(params.expectedRevision),
    files: [{ kind: 'upsert', file: { path: 'SKILL.md', contentKind: 'utf8', contentBase64: encodeUtf8Base64(params.skillMarkdown) } }],
  }, params));
  const revision = decodeSkillRevisionV1(output.revision);
  await saveSkillOrganization(params.artifactId, params, revision);
  return revision;
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

    if (!store.organization) throw Object.assign(new Error('artifact_organization_unavailable'), { code: 'artifact_organization_unavailable' });
    const organization = await readArtifactOrganizationV1({ port: store.organization, artifactId, signal: options?.signal });
    if (organization.status !== 'ready') throw Object.assign(new Error(organization.reason), { code: organization.reason });

    const admission = {
        serverId: account.serverId, expectedAccountId: account.accountId, signal: options?.signal,
        executeAction: options?.executeAction ?? (async (actionId, request, execution) => {
          const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
          return executeDefaultActionInCapturedAccount(account, actionId, request, {
            surface: 'ui', authority: 'present_user', serverId: account.serverId, expectedAccountId: account.accountId, signal: execution?.signal,
          });
        }),
    } satisfies PromptBundleActionOptions;
    const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.duplicate'].parse(await executeSkillAction('skills.duplicate', { skillId: artifactId }, admission));
    await saveSkillOrganization(output.skillId, { ...admission, folderId: organization.header.folderId ?? null, tags: organization.header.tags ?? [] }, decodeSkillRevisionV1(output.revision));
    return output.skillId;
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

    const admission = {
      artifactId,
      serverId: account.serverId,
      expectedAccountId: account.accountId,
      signal: params.signal,
      executeAction: params.executeAction ?? (async (actionId, request, execution) => {
        const { executeDefaultActionInCapturedAccount } = await import('@/sync/ops/actions/defaultActionExecutor');
        return executeDefaultActionInCapturedAccount(account, actionId, request, {
          surface: 'ui', serverId: account.serverId, expectedAccountId: account.accountId, signal: execution?.signal,
        });
      }),
    } satisfies PromptBundleActionOptions & { artifactId: string };
    const nextEntries = change(parsed.data.entries);
    const output = SKILL_ACTION_OUTPUT_SCHEMAS_V1['skills.update'].parse(await executeSkillAction('skills.update', {
      skillId: artifactId, expectedRevision: encodeSkillRevisionV1(params.expectedRevision ?? artifact.revision),
      files: [
        ...projectPromptBundleActionEntriesV1(nextEntries).map(file => ({ kind: 'upsert' as const, file })),
        ...parsed.data.entries.filter(file => !nextEntries.some(next => next.path === file.path)).map(file => ({ kind: 'remove' as const, path: file.path })),
      ],
    }, admission));
    return decodeSkillRevisionV1(output.revision);
  }, params);
}
