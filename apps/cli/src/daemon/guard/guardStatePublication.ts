import type { MachineGuardEpisodeV1, MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import { effectiveMachineMemoryPressureV1 } from '@happier-dev/protocol/machines/vitals/effectiveMachineMemoryPressureV1';
import type { MachineResourceSummary } from '@/daemon/resources/machineResourceSummary';
import type { MachineVitalsSampler } from '@/daemon/vitals/createMachineVitalsSampler';
import type { KeepAwake } from '@/integrations/keepAwake';

export interface GuardEpisodeOwner {
    readEpisode(): MachineGuardEpisodeV1 | undefined;
    subscribe(listener: () => void): () => void;
}

export interface GuardStatePublication {
    read(): MachineGuardStateV1;
    /** Call from the sampler's existing onTick, including unavailable reads. */
    refresh(): void;
    subscribe(listener: () => void): () => void;
    stop(): void;
}

export function createGuardStatePublication(input: Readonly<{
    sampler: MachineVitalsSampler;
    keepAwake: Pick<KeepAwake, 'read' | 'subscribe'>;
    episodeOwner?: GuardEpisodeOwner;
    summary: Pick<MachineResourceSummary, 'setGuardState'>;
    ceilingCapability: MachineGuardStateV1['capabilities']['ceiling'];
}>): GuardStatePublication {
    const listeners = new Set<() => void>();
    let stopped = false;
    const project = (): MachineGuardStateV1 => {
        const sample = input.sampler.latest();
        const keepAwake = input.keepAwake.read();
        const episode = input.episodeOwner?.readEpisode();
        const memoryPressure: MachineGuardStateV1['capabilities']['memoryPressure'] = input.sampler.state().state === 'unavailable' || !sample
            ? { status: 'unavailable', reason: 'sampler_unavailable' }
            : effectiveMachineMemoryPressureV1(sample.memory) === 'not_reported'
                ? { status: 'unavailable', reason: 'no_pressure_signal' } : { status: 'available' };
        return { v: 1, capabilities: { memoryPressure, ceiling: input.ceilingCapability,
            keepAwake: keepAwake.unavailableReason
                ? { modes: ['off'], unavailableReason: keepAwake.unavailableReason } : { modes: ['off', 'on', 'on_power'] },
        }, keepAwakeHolding: keepAwake.holding,
        // The episode owner may retain private candidate/episode identities. Project only the public facts.
        ...(episode ? { episode: { state: episode.state, since: episode.since,
            ...(episode.step !== undefined ? { step: episode.step } : {}),
            ...(episode.expectedReturnBytes !== undefined ? { expectedReturnBytes: episode.expectedReturnBytes } : {}),
        } } : {}) };
    };
    let current = project();
    let identity = JSON.stringify(current);
    const refresh = () => {
        if (stopped) return;
        const next = project();
        const nextIdentity = JSON.stringify(next);
        if (identity === nextIdentity) return;
        current = next;
        identity = nextIdentity;
        input.summary.setGuardState(current);
        for (const listener of listeners) listener();
    };
    // No sampling demand or tick subscription: daemon composition reuses the sampler's onTick.
    const releaseKeepAwake = input.keepAwake.subscribe(refresh);
    const releaseEpisode = input.episodeOwner?.subscribe(refresh);
    input.summary.setGuardState(current);
    return { read: () => current, refresh,
        subscribe(listener) { if (!stopped) listeners.add(listener); return () => { listeners.delete(listener); }; },
        stop() { if (stopped) return; stopped = true; releaseKeepAwake(); releaseEpisode?.(); listeners.clear(); },
    };
}
