import { z } from 'zod/mini';
import { RoleActionInputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { readSessionRolesV1, SessionRoleConfigurationV1Schema, writeSessionRoleConfigurationV1ToMetadata, writeSessionRoleIdV1ToMetadata } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';

/** Private journal intent; the public Action schemas remain the input authority. */
export const SessionRoleEditSchema = z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal('session.role.set'), input: RoleActionInputSchemasV1['session.role.set'] }),
  z.strictObject({ actionId: z.literal('session.notes.set'), input: RoleActionInputSchemasV1['session.notes.set'] }),
  z.strictObject({ actionId: z.literal('session.roles.override.set'), input: RoleActionInputSchemasV1['session.roles.override.set'] }),
  z.strictObject({ actionId: z.literal('session.roles.override.clear'), input: RoleActionInputSchemasV1['session.roles.override.clear'] }),
  z.strictObject({ actionId: z.literal('session.roles.add'), input: RoleActionInputSchemasV1['session.roles.add'] }),
  z.strictObject({ actionId: z.literal('session.roles.remove'), input: RoleActionInputSchemasV1['session.roles.remove'] }),
]);
export type SessionRoleEdit = z.infer<typeof SessionRoleEditSchema>;

/** Apply only the requested edit, including after a deferred write or journal recovery. */
export function applySessionRoleEditToMetadata<T extends Record<string, unknown>>(metadata: T, edit: SessionRoleEdit): T {
  if (edit.actionId === 'session.role.set' && edit.input.roleId !== undefined) {
    metadata = writeSessionRoleIdV1ToMetadata(metadata, edit.input.roleId);
  }
  const current = readSessionRolesV1(metadata);
  const configuration = SessionRoleConfigurationV1Schema.parse({
    overrides: current?.overrides ?? {}, sessionRoles: current?.sessionRoles ?? {}, notes: current?.notes ?? '',
    ...(current?.inheritedFrom ? { inheritedFrom: current.inheritedFrom } : {}),
  });
  switch (edit.actionId) {
    case 'session.role.set':
      if (edit.input.answersWorkerQuestions !== undefined) configuration.answersWorkerQuestions = edit.input.answersWorkerQuestions;
      break;
    case 'session.notes.set': configuration.notes = edit.input.notes; break;
    case 'session.roles.override.set': {
      const { sessionId: _sessionId, ...override } = edit.input;
      configuration.overrides[override.roleId] = { ...configuration.overrides[override.roleId], ...override };
      break;
    }
    case 'session.roles.override.clear': delete configuration.overrides[edit.input.roleId]; break;
    case 'session.roles.add': configuration.sessionRoles[edit.input.roleId] = { ...edit.input.role, roleId: edit.input.roleId }; break;
    case 'session.roles.remove': delete configuration.sessionRoles[edit.input.roleId]; break;
  }
  return writeSessionRoleConfigurationV1ToMetadata(metadata, configuration);
}
