import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import {
  CreateOrUpdateSessionOrganizationFolderRequestSchema, CreateOrUpdateSessionOrganizationFolderResponseSchema,
  CreateOrUpdateSessionOrganizationTagRequestSchema, CreateOrUpdateSessionOrganizationTagResponseSchema,
  DeleteSessionOrganizationFolderRequestSchema, DeleteSessionOrganizationFolderResponseSchema,
  DeleteSessionOrganizationTagRequestSchema, DeleteSessionOrganizationTagResponseSchema,
} from '../../sessions/organization/mutations.js';
import { SessionOrganizationSnapshotResponseSchema } from '../../sessions/organization/snapshot.js';
import { SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT, SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT } from '../../sessions/organization/constants.js';
import { homeDomainActionRow } from './homeDomainRow.js';
import type { PreNormalizedActionSpec } from '../actionSpecs.js';

const listInput = z.strictObject({});
const folderRenameInput = lazyZodSchema(() => z.extend(CreateOrUpdateSessionOrganizationFolderRequestSchema, { folderId: z.string().check(z.trim(), z.minLength(1)) }));
const tagRenameInput = lazyZodSchema(() => z.extend(CreateOrUpdateSessionOrganizationTagRequestSchema, { tagId: z.string().check(z.trim(), z.minLength(1)) }));

// Resource creation and rename use the incumbent upsert contract and display
// envelopes. This is an Action projection, never an organization store.
function row<
  const TActionId extends PreNormalizedActionSpec['id'],
  const TInputSchema extends z.ZodMiniType,
  const TOutputSchema extends z.ZodMiniType,
>(spec: Parameters<typeof homeDomainActionRow<TActionId, TInputSchema, TOutputSchema>>[0]) {
  const declared = homeDomainActionRow(spec);
  // Keep this literal family's schema/authority projection exact. The shared
  // row's broad registry type also permits unrelated surface-schema overrides;
  // those are not authored by these resource rows.
  return { id: spec.id, approval: spec.approval, title: declared.title, description: declared.description,
    safety: spec.safety, sideEffectClass: spec.sideEffectClass,
    cli: declared.cli, placements: declared.placements, inputHints: declared.inputHints,
    serverTransport: declared.serverTransport, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema,
    requiredAuthority: declared.requiredAuthority, executionPlacement: declared.executionPlacement,
    surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: true, rpc: false },
    bindings: { mcpToolName: spec.id.replaceAll('.', '_') } } as const;
}

export const SESSION_ORGANIZATION_RESOURCE_ACTION_SPECS = [
  row({ id: 'session.folders.list', approval: {result: 'required'}, title: 'List Session folders', description: 'Read the existing organization snapshot, including folder and tag identities and display envelopes.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'folders', 'list'], inputSchema: listInput, outputSchema: SessionOrganizationSnapshotResponseSchema }),
  row({ id: 'session.folders.create', approval: {result: 'required'}, title: 'Create Session folder', description: 'Create a folder for organizing sessions.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'folders', 'create'], inputSchema: CreateOrUpdateSessionOrganizationFolderRequestSchema, outputSchema: CreateOrUpdateSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.folders.rename', approval: {result: 'required'}, title: 'Rename Session folder', description: 'Change a session folder\'s name. Retain its current key, parent and order fields in the request.',
    inputHints: { description: 'Change a session folder\'s name.', fields: [] },
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/folders', cliPath: ['session', 'folders', 'rename'], inputSchema: folderRenameInput, outputSchema: CreateOrUpdateSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.folders.delete', approval: {result: 'required'}, title: 'Delete Session folder', description: 'Delete an organization folder using the existing assignment disposition contract.',
    preservePathFieldsInBody: true,
    inputHints: { fields: [
      { path: 'folderId', title: 'Folder ID', prompt: 'Use session.folders.list on the selected Home to find the folder ID.', widget: 'text', required: true },
      { path: 'assignmentBehavior', title: 'Assignment behavior', widget: 'select', options: [
        { value: SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT, label: 'Move assignments to the parent folder' },
      ] },
    ] },
    safety: 'danger', sideEffectClass: 'danger', method: 'DELETE', path: '/v2/session-organization/folders/:folderId', cliPath: ['session', 'folders', 'delete'], inputSchema: DeleteSessionOrganizationFolderRequestSchema, outputSchema: DeleteSessionOrganizationFolderResponseSchema }),
  row({ id: 'session.tags.list', approval: {result: 'required'}, title: 'List Session tags', description: 'Read the existing organization snapshot, including tag and folder identities and display envelopes.',
    safety: 'safe', sideEffectClass: 'read', method: 'GET', path: '/v2/session-organization', cliPath: ['session', 'tags', 'list'], inputSchema: listInput, outputSchema: SessionOrganizationSnapshotResponseSchema }),
  row({ id: 'session.tags.create', approval: {result: 'required'}, title: 'Create Session tag', description: 'Create a tag for labelling sessions.',
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'create'], inputSchema: CreateOrUpdateSessionOrganizationTagRequestSchema, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.rename', approval: {result: 'required'}, title: 'Rename Session tag', description: 'Change a session tag\'s name. Retain its current key and order fields in the request.',
    inputHints: { description: 'Change a session tag\'s name.', fields: [] },
    safety: 'safe', sideEffectClass: 'external', path: '/v2/session-organization/tags', cliPath: ['session', 'tags', 'rename'], inputSchema: tagRenameInput, outputSchema: CreateOrUpdateSessionOrganizationTagResponseSchema }),
  row({ id: 'session.tags.delete', approval: {result: 'required'}, title: 'Delete Session tag', description: 'Delete an organization tag using the existing assignment disposition contract.',
    preservePathFieldsInBody: true,
    inputHints: { fields: [
      { path: 'tagId', title: 'Tag ID', prompt: 'Use session.tags.list on the selected Home to find the tag ID.', widget: 'text', required: true },
      { path: 'assignmentBehavior', title: 'Assignment behavior', widget: 'select', options: [
        { value: SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT, label: 'Remove tag assignments' },
      ] },
    ] },
    safety: 'danger', sideEffectClass: 'danger', method: 'DELETE', path: '/v2/session-organization/tags/:tagId', cliPath: ['session', 'tags', 'delete'], inputSchema: DeleteSessionOrganizationTagRequestSchema, outputSchema: DeleteSessionOrganizationTagResponseSchema }),
] as const;
