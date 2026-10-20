/** The Session's shared window on one machine (computer use, lab `computer` LV). */
export type ComputerScreenSessionSurfaceResource = Readonly<{ kind: 'computerScreen'; machineId: string }>;

export function readComputerScreenSessionSurfaceResource(value: unknown): ComputerScreenSessionSurfaceResource | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const maybe = value as { kind?: unknown; machineId?: unknown };
    return maybe.kind === 'computerScreen' && typeof maybe.machineId === 'string' && maybe.machineId.trim()
        ? { kind: 'computerScreen', machineId: maybe.machineId.trim() }
        : null;
}

export const computerScreenDetailsTabKey = (machineId: string) => `computer-screen:${machineId}`;

/** The Details tab that shows a Session's shared window (one per Session and machine). */
export function createComputerScreenDetailsTab(input: Readonly<{ machineId: string; title: string; subtitle?: string | null }>) {
    return {
        key: computerScreenDetailsTabKey(input.machineId),
        kind: 'computerScreen',
        title: input.title,
        subtitle: input.subtitle ?? null,
        resource: { kind: 'computerScreen', machineId: input.machineId } satisfies ComputerScreenSessionSurfaceResource,
    };
}
