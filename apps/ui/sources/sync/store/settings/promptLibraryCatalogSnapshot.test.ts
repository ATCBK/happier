import { afterEach, describe, expect, it } from 'vitest';
import { applyPromptLibraryCatalogSnapshot, applyPromptLibraryCatalogAcknowledgedRecord, beginPromptLibraryCatalogLoad, getPromptLibraryCatalogValue, getPromptLibraryCatalogSnapshot,
    publishPromptLibrarySkillRulesDraft, resetPromptLibraryCatalogSnapshotsForTests } from './promptLibraryCatalogSnapshot';
afterEach(resetPromptLibraryCatalogSnapshotsForTests);
const scope = { serverId: 'home', accountId: 'account' };
const catalog = { status: 'ready' as const, rows: [{ record: { key: 'folders' as const,
    value: { v: 1 as const, folders: [{ id: 'folder', name: 'Folder' }] } }, revision: 3 }], tombstones: [], diagnostics: [] };
describe('Prompt library scoped publications', () => {
    it('keeps an acknowledged row in both projections when an older read finishes after the write', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const record = { key: 'folders' as const, value: { v: 1 as const, folders: [{ id: 'folder', name: 'New' }] } };
        applyPromptLibraryCatalogAcknowledgedRecord(scope, record, 4, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ revision: 4, value: record.value, stale: false });
        expect(getPromptLibraryCatalogSnapshot(scope)?.catalog).toMatchObject({ rows: [{ record, revision: 4 }] });
    });
    it('withdraws pending display intent with lost Account admission, not merely its received row', () => {
        const skillCatalog = { status: 'ready' as const, rows: [{ record: { key: 'skill-rules' as const,
            value: { v: 1 as const, rules: [] } }, revision: 3 }], tombstones: [], diagnostics: [] };
        const projection = { catalog: skillCatalog, rawSettings: {}, sourceSettingsVersion: 1 };
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        publishPromptLibrarySkillRulesDraft(scope, 'skill', [{ id: 'draft', target: { t: 'allMachines' },
            enabled: true, createdAt: 1, updatedAt: 1 }]);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value?.rules).toHaveLength(1);
        applyPromptLibraryCatalogSnapshot(scope, { ...projection, catalog: { status: 'unavailable', reason: 'unauthorized' } }, true);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value).toBeNull();
        applyPromptLibraryCatalogSnapshot(scope, projection, true);
        expect(getPromptLibraryCatalogValue(scope, 'skill-rules').value?.rules).toEqual([]);
    });
    it('retains partial tombstone evidence through refresh and rejects lower or duplicate row receipts', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'partial', rows: [],
            tombstones: [{ key: 'folders', revision: 10 }], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        beginPromptLibraryCatalogLoad(scope);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'unreachable' },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const retained = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 6, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 10, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 11, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(retained);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 11, true);
        const recreated = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, { ...catalog.rows[0]!.record,
            value: { v: 1, folders: [] } }, 11, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(recreated);
        expect(recreated).toMatchObject({ revision: 11, stale: false, value: catalog.rows[0]!.record.value });
        const otherScope = { ...scope, accountId: 'other-account' };
        applyPromptLibraryCatalogAcknowledgedRecord(otherScope, catalog.rows[0]!.record, 6, true);
        expect(getPromptLibraryCatalogValue(otherScope, 'folders').revision).toBe(6);
    });
    it('publishes an acknowledged row during refresh without replacing siblings, newer receipts, or retired Accounts', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        beginPromptLibraryCatalogLoad(scope);
        const sibling = getPromptLibraryCatalogValue(scope, 'role-overrides');
        const record = { key: 'folders' as const, value: { v: 1 as const, folders: [{ id: 'folder', name: 'Acknowledged' }] } };
        applyPromptLibraryCatalogAcknowledgedRecord(scope, record, 4, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'ready', stale: false, revision: 4, value: record.value });
        const acknowledged = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 3, true);
        applyPromptLibraryCatalogAcknowledgedRecord(scope, catalog.rows[0]!.record, 5, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(acknowledged);
        expect(getPromptLibraryCatalogValue(scope, 'role-overrides')).toBe(sibling);
    });
    it('keeps unchanged active domains stable across preference revisions and sibling catalog edits', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const first = getPromptLibraryCatalogValue(scope, 'folders');
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 2 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
        applyPromptLibraryCatalogSnapshot({ serverId: 'other', accountId: 'account' }, { catalog, rawSettings: {}, sourceSettingsVersion: 3 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toBe(first);
    });
    it('retains display content while refreshing, rejects retired results, and withdraws private data on lost admission', () => {
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, true);
        const value = getPromptLibraryCatalogValue(scope, 'folders').value;
        beginPromptLibraryCatalogLoad(scope);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'loading', stale: true, value });
        applyPromptLibraryCatalogSnapshot(scope, { catalog, rawSettings: {}, sourceSettingsVersion: 1 }, false);
        expect(getPromptLibraryCatalogValue(scope, 'folders').status).toBe('loading');
        applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'unavailable', reason: 'encryption-material-unavailable' },
            rawSettings: {}, sourceSettingsVersion: 1 }, true);
        expect(getPromptLibraryCatalogValue(scope, 'folders')).toMatchObject({ status: 'unavailable', value: null });
    });
});
