import { useSessionDirectoryKind, useSessionProjectScmIsRepo } from '@/sync/store/hooks';

export function resolveSessionSourceControlAvailability(input: Readonly<{
    directoryKind: 'path' | 'managed' | null;
    isRepo: boolean | null;
}>): boolean {
    return input.directoryKind !== 'managed' || input.isRepo === true;
}

/** Canonical Session-level SCM availability for every shell surface. */
export function useSessionSourceControlAvailability(
    sessionId: string,
    serverId?: string | null,
): boolean {
    const directoryKind = useSessionDirectoryKind(sessionId, serverId);
    const isRepo = useSessionProjectScmIsRepo(directoryKind === 'managed' ? sessionId : null, serverId);
    return resolveSessionSourceControlAvailability({ directoryKind, isRepo });
}
