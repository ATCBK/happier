import type { ProcessOwnerRef } from '@/processes/ownerTag';
import type { LanguageServerDefinition } from './languageServerDefinitions';

export const LANGUAGE_SERVER_SERVICE_ID_PREFIX = 'lsp:';

export function serviceOwnerRole(owner: ProcessOwnerRef | null | undefined): 'language_server' | undefined {
    return owner?.kind === 'service' && owner.serviceId.startsWith(LANGUAGE_SERVER_SERVICE_ID_PREFIX)
        ? 'language_server' : undefined;
}

export function serviceOwnerDisplayName(owner: ProcessOwnerRef, definitions: readonly LanguageServerDefinition[]): string | undefined {
    if (owner.kind !== 'service' || !serviceOwnerRole(owner)) return undefined;
    const definitionId = owner.serviceId.slice(LANGUAGE_SERVER_SERVICE_ID_PREFIX.length, owner.serviceId.lastIndexOf(':'));
    return definitions.find(definition => definition.id === definitionId)?.title;
}
