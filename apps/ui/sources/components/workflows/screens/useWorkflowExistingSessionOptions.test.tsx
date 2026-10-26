import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storageStore';
import { useWorkflowExistingSessionOptions } from './useWorkflowExistingSessionOptions';
import { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';

describe('Workflow existing Session options', () => {
    it('does no detailed option work across Session arrivals while closed, then reads current options on open and reopen', async () => {
        const previous = storage.getState();
        let nameReads = 0;
        let eligibilityReads = 0;
        const session = (index: number) => createSessionFixture({ id: `closed-cost-${index}`, serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: `resume-${index}`,
            claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/repo', name: `Session ${index}`,
        } });
        const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const value = session(index);
            Object.defineProperty(value.metadata, 'name', { enumerable: true, get: () => { nameReads += 1; return `Session ${index}`; } });
            Object.defineProperty(value, 'metadataUnavailable', { enumerable: true, get: () => { eligibilityReads += 1; return false; } });
            return [value.id, value];
        }));
        storage.setState({ isDataReady: true, sessions, sessionListRowsByServerId: {} });
        const hook = await renderHook(({ enabled }) => useWorkflowExistingSessionOptions({
            serverId: 'home-a', machineId: 'machine-a', enabled,
        }), { initialProps: { enabled: false } });
        try {
            nameReads = 0;
            eligibilityReads = 0;
            await act(async () => {
                for (let index = 1000; index < 1005; index += 1) storage.setState(state => ({
                    sessions: { ...state.sessions, [`closed-cost-${index}`]: session(index) },
                }));
            });
            expect(nameReads).toBe(0);
            expect(eligibilityReads).toBe(0);
            expect(hook.getCurrent().existingSessions).toEqual([]);
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().existingSessions).toHaveLength(1005);
            expect(nameReads).toBeGreaterThan(0);
            expect(eligibilityReads).toBeGreaterThan(0);
            await hook.rerender({ enabled: false });
            nameReads = 0;
            eligibilityReads = 0;
            await act(async () => { storage.setState(state => ({ sessions: {
                ...state.sessions, 'closed-cost-1005': session(1005),
            } })); });
            expect(nameReads).toBe(0);
            expect(eligibilityReads).toBe(0);
            expect(hook.getCurrent().sessionDropCandidates).toEqual([]);
            await hook.rerender({ enabled: true });
            expect(hook.getCurrent().existingSessions).toHaveLength(1006);
        } finally { await hook.unmount(); storage.setState(previous); }
    });
    it.each([false, true])('does no hydrated-option work for unrelated publications (chooser enabled: %s)', async (enabled) => {
        const previous = storage.getState();
        let nameReads = 0;
        let unchangedSessionNameReads = 0;
        const sessions = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
            const session = createSessionFixture({ id: `cost-${index}`, serverId: 'home-a', metadata: {
                ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: `resume-${index}`,
                claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/repo',
            } });
            // Count real display projection work without replacing candidacy, target or label logic.
            Object.defineProperty(session.metadata, 'name', { enumerable: true, get: () => {
                nameReads += 1;
                if (index !== 0) unchangedSessionNameReads += 1;
                return `Session ${index}`;
            } });
            return [session.id, session];
        }));
        storage.setState({ isDataReady: true, sessions });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a', enabled }));
        try {
            expect(hook.getCurrent().existingSessions).toHaveLength(enabled ? 1000 : 0);
            if (enabled) expect(nameReads).toBeGreaterThan(0);
            else expect(nameReads).toBe(0);
            nameReads = 0;
            const before = hook.getCurrent();
            await act(async () => {
                for (let index = 0; index < 20; index += 1) storage.getState().applyLocalSettings({
                    uiFontScale: index % 2 === 0 ? 1.1 : 1.2,
                }, { persist: false });
            });
            expect(nameReads).toBe(0);
            expect(hook.getCurrent()).toBe(before);
            await act(async () => {
                for (let index = 0; index < 20; index += 1) storage.setState(state => ({
                    settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
                }));
            });
            expect(nameReads).toBe(0);
            expect(hook.getCurrent()).toBe(before);
            unchangedSessionNameReads = 0;
            await act(async () => {
                for (let index = 0; index < 20; index += 1) storage.setState(state => ({
                    sessions: { ...state.sessions, 'cost-0': {
                        ...state.sessions['cost-0']!, updatedAt: state.sessions['cost-0']!.updatedAt + 1,
                    } },
                }));
            });
            console.info('Workflow Session-arrival cost', { enabled, arrivals: 20, sessions: 1000,
                nameReads, unchangedSessionNameReads });
            expect(unchangedSessionNameReads).toBe(0);
            expect(hook.getCurrent()).toBe(before);
        } finally {
            await hook.unmount();
            storage.getState().applyLocalSettings({ uiFontScale: previous.localSettings.uiFontScale }, { persist: false });
            storage.setState(previous);
        }
    });

    it('refreshes hydrated candidacy when Account Agent enablement changes', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'policy-option', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: 'resume-id',
            claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/repo', name: 'Policy',
        } });
        storage.setState({ isDataReady: true, sessions: { [session.id]: session }, sessionListRowsByServerId: {} });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a' }));
        try {
            expect(hook.getCurrent().existingSessions).toHaveLength(1);
            await act(async () => { storage.setState(state => ({ settings: { ...state.settings,
                backendEnabledByTargetKey: { ...state.settings.backendEnabledByTargetKey,
                    'agent:happier.agent.claude/claude': false },
            } })); });
            expect(hook.getCurrent().existingSessions).toEqual([]);
            expect(hook.getCurrent().sessionDropCandidates).toEqual([]);
            await act(async () => { storage.setState({ settings: previous.settings }); });
            expect(hook.getCurrent().existingSessions).toHaveLength(1);
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('refreshes translated fallback names when the ready locale changes without Session facts changing', async () => {
        const previous = storage.getState();
        const previousLanguage = getPreferredLanguage();
        await preloadTranslations('en');
        setPreferredLanguageFromSettings('en');
        const session = createSessionFixture({ id: 'locale-option', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: 'resume-id',
            claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/', name: '',
        } });
        storage.setState({ isDataReady: true, sessions: { [session.id]: session }, sessionListRowsByServerId: {} });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a', enabled: true }));
        try {
            const before = t('session.untitled');
            expect(hook.getCurrent().existingSessions[0]?.label).toBe(before);
            await act(async () => {
                await preloadTranslations('fr');
                setPreferredLanguageFromSettings('fr');
                // Ready locale publication follows asynchronous chunk loading;
                // unrelated root publications must not pin an older label.
                storage.setState(state => ({ localSettings: { ...state.localSettings } }));
            });
            expect(t('session.untitled')).not.toBe(before);
            expect(hook.getCurrent().existingSessions[0]?.label).toBe(t('session.untitled'));
        } finally {
            await hook.unmount();
            await preloadTranslations(previousLanguage);
            setPreferredLanguageFromSettings(previousLanguage);
            storage.setState(previous);
        }
    });

    it('keeps current hydrated options while demanded', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'closed-summary', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: 'resume-id',
            claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/repo', name: 'Original',
        } });
        storage.setState({ isDataReady: true, sessions: { [session.id]: session } });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a', enabled: true }));
        try {
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id, label: 'Original' }]);
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, name: 'Current summary' },
            } } }); });
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id, label: 'Current summary' }]);
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('refreshes the canonical list-row target without requiring a hydrated Session write', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'target-projection', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!, flavor: 'claude', claudeSessionId: 'resume-id',
            claudeTranscriptPath: '/tmp/transcript.jsonl', machineId: 'machine-a', path: '/repo', name: 'Target',
        } });
        storage.setState({ isDataReady: true, sessions: { [session.id]: session }, sessionListRowsByServerId: {} });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a', enabled: true }));
        try {
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id, machineId: 'machine-a' }]);
            await act(async () => { storage.setState({ sessionListRowsByServerId: { 'home-a': {
                [session.id]: { ...session, metadata: { ...session.metadata!, machineId: 'machine-b' } },
            } } }); });
            expect(hook.getCurrent().existingSessions).toEqual([]);
            expect(hook.getCurrent().sessionDropCandidates).toMatchObject([{ sessionId: session.id, machineId: 'machine-b' }]);
        } finally { await hook.unmount(); storage.setState(previous); }
    });
    it('does not recheck Session candidacy on unrelated store publications', async () => {
        const previous = storage.getState();
        let eligibilityReads = 0;
        const session = createSessionFixture({ id: 'workflow-computation', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!,
            flavor: 'claude', claudeSessionId: 'resume-id', claudeTranscriptPath: '/tmp/transcript.jsonl',
            machineId: 'machine-a', path: '/repo', name: 'Original',
        } });
        // Observe the genuine candidacy path without replacing its domain logic.
        Object.defineProperty(session, 'metadataUnavailable', { get: () => { eligibilityReads += 1; return false; } });
        storage.setState({ isDataReady: true, sessions: { [session.id]: session } });
        const hook = await renderHook(() => useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a' }));
        try {
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id }]);
            expect(eligibilityReads).toBeGreaterThan(0);
            const before = eligibilityReads;
            await act(async () => {
                for (let i = 0; i < 20; i += 1) storage.setState(state => ({
                    localSettings: { ...state.localSettings },
                }));
            });
            expect(eligibilityReads).toBe(before);
        } finally { await hook.unmount(); storage.setState(previous); }
    });

    it('ignores unrelated publications but refreshes names, candidacy and exact Machine selection', async () => {
        const previous = storage.getState();
        const session = createSessionFixture({ id: 'workflow-option', serverId: 'home-a', metadata: {
            ...createSessionFixture().metadata!,
            flavor: 'claude', claudeSessionId: 'resume-id', claudeTranscriptPath: '/tmp/transcript.jsonl',
            machineId: 'machine-a', path: '/repo', name: 'Original',
        } });
        let renders = 0;
        storage.setState({ isDataReady: true, sessions: { [session.id]: session } });
        const hook = await renderHook(() => {
            renders += 1;
            return useWorkflowExistingSessionOptions({ serverId: 'home-a', machineId: 'machine-a' });
        });
        try {
            expect(hook.getCurrent().existingSessions).toMatchObject([{ sessionId: session.id, machineId: 'machine-a' }]);
            const initial = hook.getCurrent();
            const before = renders;
            await act(async () => { storage.setState(state => ({
                settings: { ...state.settings, analyticsOptOut: !state.settings.analyticsOptOut },
                sessions: { ...state.sessions, [session.id]: { ...session, updatedAt: session.updatedAt + 1 } },
            })); });
            expect(hook.getCurrent()).toBe(initial);
            expect(renders).toBe(before);
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, name: 'Renamed' },
            } } }); });
            expect(hook.getCurrent().existingSessions[0]?.label).toBe('Renamed');
            await act(async () => { storage.setState({ sessions: { [session.id]: { ...session, archivedAt: 42 } } }); });
            expect(hook.getCurrent().existingSessions).toEqual([]);
            expect(hook.getCurrent().sessionDropCandidates).toEqual([]);
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, machineId: 'machine-b' },
            } } }); });
            expect(hook.getCurrent().existingSessions).toEqual([]);
            expect(hook.getCurrent().sessionDropCandidates[0]?.machineId).toBe('machine-b');
            await act(async () => { storage.setState({ sessions: { [session.id]: {
                ...session, metadata: { ...session.metadata!, claudeSessionId: undefined, claudeTranscriptPath: undefined },
            } } }); });
            expect(hook.getCurrent().sessionDropCandidates).toEqual([]);
        } finally { await hook.unmount(); storage.setState(previous); }
    });
});
