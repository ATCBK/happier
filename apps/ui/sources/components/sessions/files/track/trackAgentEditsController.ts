export type TrackPauseReason = 'scroll' | 'touch' | 'selection' | 'typing' | 'tabActivation' | 'dirtyEditor';
export type TrackRegion = Readonly<{ startLine: number; endLine: number; column?: number }>;
/** Fields Track consumes from P3's live-writes projection; Track never extracts tool calls. */
export type TrackWrite = Readonly<{ toolCallId: string; startedAt: number; sessionId: string; region?: TrackRegion; anchorText?: string }>;
export type TrackTarget = Readonly<{ path: string; write: TrackWrite; region?: TrackRegion }>;
export type TrackAgentEditsSnapshot = Readonly<{
    enabled: boolean;
    paused: boolean;
    pauseReason: TrackPauseReason | null;
    /** Live presence also feeds the phone's Watch entry point when following is disabled. */
    target: TrackTarget | null;
}>;
export type TrackAgentEditsInput = Readonly<{
    enabled: boolean;
    /** The session lifecycle owner's effective activity, independent of whether a tool is writing. */
    sessionActive: boolean;
    sessionId: string;
    writes: ReadonlyMap<string, TrackWrite>;
    activePath: string | null;
    previewPath?: string | null;
    dirtyPaths: ReadonlySet<string>;
}>;
export type TrackAgentEditsEffects = Readonly<{
    openPreview: (target: TrackTarget, token: symbol) => void;
    revealRegion: (target: TrackTarget, behavior: 'smooth' | 'instant', token: symbol) => void;
    reducedMotion: () => boolean;
}>;

/** The file this Session's agent is writing now: its newest write. Also feeds the phone's Watch capsule. */
export function selectTrackTarget(writes: ReadonlyMap<string, TrackWrite>, sessionId: string): TrackTarget | null {
    let target: TrackTarget | null = null;
    for (const [path, write] of writes) {
        // P3 owns eligibility; a workspace union must still never move a different session.
        if (write.sessionId !== sessionId) continue;
        if (!target || write.startedAt >= target.write.startedAt) target = { path, write, region: write.region };
    }
    return target;
}

/** One session-local decision owner. Tool extraction and lifecycle admission belong to P3. */
export function createTrackAgentEditsController(effects: TrackAgentEditsEffects) {
    let snapshot: TrackAgentEditsSnapshot = { enabled: false, paused: false, pauseReason: null, target: null };
    let input: TrackAgentEditsInput | null = null;
    let sessionId: string | null = null;
    let openedPath: string | null = null;
    const listeners = new Set<() => void>();
    const token = Symbol('track-programmatic-move');

    function publish(next: TrackAgentEditsSnapshot) {
        if (snapshot.enabled === next.enabled && snapshot.paused === next.paused
            && snapshot.pauseReason === next.pauseReason && snapshot.target === next.target) return;
        snapshot = next;
        for (const listener of listeners) listener();
    }

    function isDirty(target: TrackTarget) {
        if (!input) return false;
        return input.dirtyPaths.has(target.path)
            || (input.activePath !== null && input.dirtyPaths.has(input.activePath))
            || (input.previewPath != null && input.dirtyPaths.has(input.previewPath));
    }

    function follow(resuming: boolean, previousTarget: TrackTarget | null) {
        const target = snapshot.target;
        if (!snapshot.enabled || !target || !input) return;
        if (isDirty(target)) {
            publish({ ...snapshot, paused: true, pauseReason: 'dirtyEditor' });
            return;
        }
        if (snapshot.paused) return;
        const pathChanged = openedPath !== target.path;
        if ((pathChanged || resuming) && input.activePath !== target.path) {
            effects.openPreview(target, token);
        }
        openedPath = target.path;
        const regionChanged = previousTarget?.path !== target.path
            || previousTarget?.region?.startLine !== target.region?.startLine
            || previousTarget?.region?.endLine !== target.region?.endLine
            || previousTarget?.region?.column !== target.region?.column;
        if (target.region && (resuming || pathChanged || regionChanged)) {
            effects.revealRegion(target, effects.reducedMotion() ? 'instant' : 'smooth', token);
        }
    }

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        update: (nextInput: TrackAgentEditsInput) => {
            input = nextInput;
            const sessionChanged = sessionId !== input.sessionId;
            sessionId = input.sessionId;
            if (sessionChanged || !input.enabled || !input.sessionActive) openedPath = null;
            // Watch/presence still needs the live path while the device-local follow preference is off.
            let target = input.sessionActive ? selectTrackTarget(input.writes, input.sessionId) : null;
            const previousTarget = sessionChanged ? null : snapshot.target;
            if (target && previousTarget?.path === target.path) {
                const previousRegion = previousTarget.region;
                const nextRegion = target.region;
                if (previousRegion && nextRegion && previousRegion.startLine === nextRegion.startLine
                    && typeof previousRegion.column === 'number' && typeof nextRegion.column === 'number'
                    && nextRegion.column < previousRegion.column) {
                    target = { ...target, region: previousRegion };
                }
                if (previousTarget.write === target.write && previousTarget.region === target.region) target = previousTarget;
            }
            const retainPause = input.enabled && input.sessionActive && !sessionChanged;
            publish({ enabled: input.enabled, target,
                paused: retainPause && snapshot.paused,
                pauseReason: retainPause ? snapshot.pauseReason : null });
            follow(false, previousTarget);
        },
        pause: (reason: TrackPauseReason, originToken?: symbol) => {
            if (originToken === token || !snapshot.enabled || !input?.sessionActive) return;
            publish({ ...snapshot, paused: true, pauseReason: reason });
        },
        resume: () => {
            if (!snapshot.enabled) return;
            publish({ ...snapshot, paused: false, pauseReason: null });
            follow(true, null);
        },
    };
}

export type TrackAgentEditsController = ReturnType<typeof createTrackAgentEditsController>;
