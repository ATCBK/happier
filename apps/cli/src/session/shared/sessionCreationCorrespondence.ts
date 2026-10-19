import { SessionCreationCorrespondenceV1Schema, type SessionCreationCorrespondenceV1, type SessionCreationImmutableRecipeV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { deriveSessionCreationTagV1, type SessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';

type CreationRecipeInput = Pick<SessionCreationImmutableRecipeV1, 'execution' | 'organization' | 'agentTarget'>
  & Partial<Omit<SessionCreationImmutableRecipeV1, 'execution' | 'organization' | 'agentTarget' | 'allowedTools'>>
  & Readonly<{ allowedTools?: Readonly<SessionCreationImmutableRecipeV1['allowedTools']> }>;

/** Shared immutable birth producer for ordinary Actions and host-owned Session creation. */
export function buildSessionCreationCorrespondence(input: Readonly<{
  identity: Readonly<{ sessionCreationTag: SessionCreationTagV1 }>
    | Readonly<{ callerCreationNamespace: string; creationKey: string }>;
  recipe: CreationRecipeInput;
}>): SessionCreationCorrespondenceV1 {
  const sessionCreationTag = 'sessionCreationTag' in input.identity ? input.identity.sessionCreationTag
    : deriveSessionCreationTagV1(input.identity);
  return SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag, recipe: {
    modelSelection: null, profileId: null, requestedPermissionMode: null, agentModeId: null, configuration: null,
    connectedServices: null, capabilitySelection: null, transcriptStorage: null, terminal: null,
    agentSessionStartupInstructionsMarkerV1: null, checkout: null,
    ...input.recipe,
  } });
}
