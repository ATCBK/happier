import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRecordV1Schema, PromptLibraryRowMutationV1Schema } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { getActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createDeferred } from '@/testkit/async/deferred';
import { createSkillUsageRecorder } from './skillUsage';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });

function fixture(options?: { deferAccountPublication?: boolean }) {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'skill-usage-owner' })).toString('base64url')}.signature`, encryption: null };
    const publishAccount = () => setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
        settingsVersion: 7, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    if (!options?.deferAccountPublication) publishAccount();
    let revision = 1;
    let value = { v: 1 as const, lastUsedAt: {} as Record<string, number> };
    let unreadable = false;
    let conflict = false;
    const writes: unknown[] = [];
    vi.spyOn(axios, 'get').mockImplementation(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
            settingsVersion: 7, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
        if (path === '/v1/account/entity-rows/prompt-library') {
            if (unreadable) throw new Error('Home unavailable');
            return { status: 200, data: { status: 'listed', rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key,
                revision: key === 'skill-usage' ? revision : 1,
                content: { t: 'plain', v: key === 'skill-usage' ? { key, value } : emptyPromptLibraryRecordV1(key) } })) } };
        }
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 7 } };
        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [] } };
        if (path === '/v1/account/entity-rows/profiles/transfer') return { status: 200, data: { status: 'absent' } };
        throw new Error(`Unexpected Home route ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        expect(new URL(String(url)).pathname).toBe('/v1/account/entity-rows/prompt-library/skill-usage');
        const mutation = PromptLibraryRowMutationV1Schema.parse(body);
        writes.push(mutation);
        if (conflict) {
            value = { v: 1, lastUsedAt: { guide: Date.now() } };
            conflict = false;
            return { status: 409, data: { status: 'conflict', revision: ++revision } };
        }
        if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
        if (mutation.content?.t !== 'plain') throw new Error('Expected plain Account row');
        const record = PromptLibraryRecordV1Schema.parse(mutation.content.v);
        if (record.key !== 'skill-usage') throw new Error('Expected skill usage record');
        value = record.value;
        return { status: 200, data: { status: 'updated', revision: ++revision, cursor: revision } };
    });
    const account = { accountId: 'skill-usage-owner', serverHttpBaseUrl: resolveServerHttpBaseUrl() };
    return { credentials, account, writes, publishAccount, read: () => ({ revision, value }), failRead: () => { unreadable = true; },
        conflict: () => { conflict = true; } };
}

describe('daemon Account skill-use writer', () => {
    it('records fresh use after the daemon starts before its first Account settings publication', async () => {
        const f = fixture({ deferAccountPublication: true });
        const recorder = createSkillUsageRecorder({ credentials: f.credentials });
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toEqual([]);
        f.publishAccount();
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.read().value.lastUsedAt.guide).toBeDefined();
        expect(f.writes).toHaveLength(1);
    });
    it('records use once per skill per day and publishes the acknowledged row for subsequent reads', async () => {
        const f = fixture();
        vi.spyOn(Date, 'now').mockReturnValue(100_000_000);
        const recorder = createSkillUsageRecorder({ credentials: f.credentials });
        await recorder.recordSkillUse({ skillIds: ['guide', 'guide'], account: f.account });
        expect(f.read()).toEqual({ revision: 2, value: { v: 1, lastUsedAt: { guide: 100_000_000 } } });
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toHaveLength(1);
        expect(getActiveAccountSettingsSnapshot()?.promptLibraryCatalog).toMatchObject({ rows: expect.arrayContaining([
            { revision: 2, record: { key: 'skill-usage', value: { v: 1, lastUsedAt: { guide: 100_000_000 } } } },
        ]) });
        vi.mocked(Date.now).mockReturnValue(186_400_000);
        await recorder.recordSkillUse({ skillIds: ['guide', 'second'], account: f.account });
        expect(f.read().value.lastUsedAt).toEqual({ guide: 186_400_000, second: 186_400_000 });
        expect(f.writes).toHaveLength(2);
    });
    it('does not write when the Account row cannot be read', async () => {
        const f = fixture(); f.failRead();
        await createSkillUsageRecorder({ credentials: f.credentials }).recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toEqual([]);
    });
    it('drops a CAS conflict without retry and replans the next use from the winning row', async () => {
        const f = fixture(); f.conflict();
        await createSkillUsageRecorder({ credentials: f.credentials }).recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toHaveLength(1);
        expect(f.read().value.lastUsedAt.guide).toBeDefined();
        await createSkillUsageRecorder({ credentials: f.credentials }).recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toHaveLength(1);
    });
    it('drops a rejected observation, releases its in-flight reservation and records a fresh use after recovery', async () => {
        const f = fixture();
        vi.spyOn(Date, 'now').mockReturnValue(100_000_000);
        const post = vi.mocked(axios.post).getMockImplementation()!;
        const admitted = createDeferred<void>(); const release = createDeferred<void>();
        vi.mocked(axios.post).mockImplementationOnce(async () => {
            admitted.resolve(); await release.promise;
            return { status: 503, data: { error: 'fixture_no_write' } };
        });
        const recorder = createSkillUsageRecorder({ credentials: f.credentials });
        const first = recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        await admitted.promise;
        try {
            await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
            expect(vi.mocked(axios.post)).toHaveBeenCalledTimes(1);
        } finally { release.resolve(); await first; }
        expect(f.read()).toEqual({ revision: 1, value: { v: 1, lastUsedAt: {} } });
        vi.mocked(axios.post).mockImplementation(post);
        vi.mocked(Date.now).mockReturnValue(100_000_100);
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.read()).toEqual({ revision: 2, value: { v: 1, lastUsedAt: { guide: 100_000_100 } } });
        // The interval starts at the stored use, not the rejected earlier attempt.
        vi.mocked(Date.now).mockReturnValue(186_400_000);
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toHaveLength(1);
        vi.mocked(Date.now).mockReturnValue(186_400_100);
        await recorder.recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.read().value.lastUsedAt.guide).toBe(186_400_100);
        expect(f.writes).toHaveLength(2);
    });
    it('cannot write into an Account lifetime retired during storage currentness validation', async () => {
        const f = fixture();
        const admitted = createDeferred<void>(); const release = createDeferred<void>();
        const get = vi.mocked(axios.get).getMockImplementation()!;
        const snapshot = getActiveAccountSettingsSnapshot()!;
        setActiveAccountSettingsSnapshot({ ...snapshot, promptLibraryCatalog: { status: 'ready', rows:
            PromptLibraryCatalogKeyV1Schema.options.map(key => ({ revision: 1, record: emptyPromptLibraryRecordV1(key) })),
            tombstones: [], diagnostics: [] } });
        vi.mocked(axios.get).mockImplementation(async (...args) => {
            if (new URL(String(args[0])).pathname === '/v1/account/encryption/currentness') {
                admitted.resolve(); await release.promise;
            }
            return get(...args);
        });
        const recording = createSkillUsageRecorder({ credentials: f.credentials }).recordSkillUse({ skillIds: ['guide'], account: f.account });
        try {
            await admitted.promise;
            resetActiveAccountSettingsSnapshotForTests();
            release.resolve(); await recording;
            expect(f.writes).toEqual([]);
        } finally { release.resolve(); await recording; }
    });
    it.each([
        { accountId: 'foreign-account' },
        { serverHttpBaseUrl: 'https://foreign-home.example.invalid' },
    ])('does not borrow the daemon Account for another target %j', async foreign => {
        const f = fixture();
        await createSkillUsageRecorder({ credentials: f.credentials }).recordSkillUse({ skillIds: ['happier:happier'],
            account: { ...f.account, ...foreign } });
        expect(f.writes).toEqual([]);
        expect(vi.mocked(axios.get)).not.toHaveBeenCalled();
    });
    it('matches the Account identity rather than the access-token lifetime', async () => {
        const f = fixture();
        const credentials = { ...f.credentials, token: f.credentials.token.replace('signature', 'ephemeral-signature') };
        setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, scopeKey: resolveAccountSettingsScopeKey(credentials) });
        await createSkillUsageRecorder({ credentials }).recordSkillUse({ skillIds: ['guide'], account: f.account });
        expect(f.writes).toHaveLength(1);
        expect(f.read().value.lastUsedAt.guide).toBeDefined();
    });
});
