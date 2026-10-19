import { afterEach, describe, expect, it } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { buildApprovalPreviewSummary } from '@happier-dev/protocol/actions/actionExecutor';
import { preloadTranslations, setPreferredLanguageFromSettings, t } from '@/text';
import { presentActionApproval, readActionApprovalSubject } from './actionApprovalPresentation';
import { buildRoleCatalog } from '@/sync/domains/roles/roleCatalog';
import { BUILT_IN_ROLES_V1 } from '@happier-dev/protocol/prompts/roles/builtInRolesV1';

afterEach(() => setPreferredLanguageFromSettings('en'));

describe('the shared Action approval presentation owner', () => {
    it('retains captured widget and plugin-page names in a request preview across locales', async () => {
        const actionArgs = { ref: { surface: { serverId: 'home', accountId: 'account', owner: {
            kind: 'pluginArea', pluginId: 'examples.widget-areas', pageId: 'overview', area: 'pinned',
        } }, instanceId: 'removed-copy' } };
        const preview = { widgetPresentation: { widgetName: 'Directory count', pageName: 'Widget areas', areaName: 'Pinned' } };
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const presentation = presentActionApproval({ actionId: 'widgets.item.remove', actionArgs, preview });
            expect(presentation.summary).toContain('Directory count');
            expect(presentation.summary).toContain('Widget areas · Pinned');
            if (language === 'en') expect(presentation.summary).toBe('Remove “Directory count” from Widget areas · Pinned.');
        }
    });
    it('omits a title-only fallback while retaining a distinct authored consequence', async () => {
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const spec = getActionSpec('session.draft.delete');
            expect(presentActionApproval({ actionId: spec.id }).summary).toBeNull();
            expect(presentActionApproval({ actionId: spec.id, authoredSummary: buildApprovalPreviewSummary(spec, {}) }).summary).toBeNull();
            expect(presentActionApproval({ actionId: spec.id, authoredSummary: 'A distinct consequence.' }).summary).toBe('A distinct consequence.');
        }
    });
    it('keeps the Personal Home backup clone-authority disclosure in confirmation and Inbox presentation', async () => {
        const spec = getActionSpec('relay.runtime.personal_home.backup');
        const actionArgs = spec.inputSchema.parse({ purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' } });
        const input = { actionId: spec.id, actionArgs };
        for (const language of ['en', 'fr'] as const) {
            await preloadTranslations(language);
            setPreferredLanguageFromSettings(language);
            const confirmation = presentActionApproval(input);
            const disclosure = t('personalHome.settings.backupDisclosureBody');
            expect(confirmation.summary).toContain(disclosure);
            expect(presentActionApproval({ ...input, authoredSummary: buildApprovalPreviewSummary(spec, actionArgs) }))
                .toEqual(confirmation);
            expect(presentActionApproval({ ...input, authoredSummary: 'Export to your chosen archive.' }).summary)
                .toBe(`Export to your chosen archive.\n\n${disclosure}`);
        }
    });

    it('names the actual Role and its catalog source for override and Reset approvals', () => {
        const roles = buildRoleCatalog({ items: [
            { roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: '6780a145-8590-47fa-b294-c5a90aef4041', role: { ...BUILT_IN_ROLES_V1.builder, name: 'Payments reviewer' }, shared: false, viewOnly: false, migratedFromV0_2: false },
            { roleId: 'plugin:acme/reviewer', role: { ...BUILT_IN_ROLES_V1.reviewer, name: 'Security reviewer' }, shared: false, viewOnly: true, migratedFromV0_2: false },
            { roleId: 'shared-role', role: { ...BUILT_IN_ROLES_V1.reviewer, name: 'Team reviewer' }, shared: true, viewOnly: true, migratedFromV0_2: false },
        ], overrides: {} });
        const sourceLabels = { built_in: t('roles.settings.sourceBuiltIn'), user: t('roles.settings.sourceYours'), plugin: t('roles.settings.groupPlugins'), shared: t('roles.settings.sourceShared') };
        for (const role of roles) {
            for (const actionId of ['roles.override.set', 'roles.override.reset'] as const) {
                const presentation = presentActionApproval({ actionId, actionArgs: { roleId: role.roleId }, role });
                expect(presentation.title).toContain(role.role.name);
                expect(presentation.title).toContain(sourceLabels[role.source]);
                expect(presentation.summary).toContain(role.role.name);
                expect(presentation.summary).toContain(sourceLabels[role.source]);
            }
        }
        const role = roles[0]!;
        expect(presentActionApproval({ actionId: 'roles.override.reset', actionArgs: { roleId: 'different' }, role }).title)
            .not.toContain(role.role.name);
    });

    it('reads the canonical typed document reference and localizes both confirmation and request copy', async () => {
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        const spec = getActionSpec('artifact.public_link.create');
        const actionArgs = spec.inputSchema.parse({ artifactId: 'release-notes' });
        expect(readActionApprovalSubject({ actionId: spec.id, actionArgs })).toEqual({ kind: 'artifact', id: 'release-notes' });
        const input = { actionId: spec.id, actionArgs, subject: 'Notes de version' };
        const confirmation = presentActionApproval(input);
        const request = presentActionApproval({ ...input, authoredSummary: buildApprovalPreviewSummary(spec, actionArgs) });
        expect(confirmation).toEqual(request);
        expect(confirmation).toEqual({ title: 'Créer un lien public pour « Notes de version » ?',
            summary: 'Toute personne disposant de ce lien pourra lire le document.' });
        expect(presentActionApproval({ actionId: 'artifact.delete', actionArgs: { artifactId: 'release-notes' } }).title)
            .toBe('Supprimer un document');
        expect(presentActionApproval({ actionId: 'ui.pet.choose', actionArgs: {} }).summary)
            .toBe(t('commandPalette.pets.chooseSubtitle'));
    });

    it('leaves a workspace-sync request titled by its Action; its machine and folders read in Details', async () => {
        const actionArgs = { controllerMachineId: 'machine-1', relationshipId: 'relationship_1' };
        expect(readActionApprovalSubject({ actionId: 'workspace.sync.relationship.flush', actionArgs })).toBeUndefined();
        expect(presentActionApproval({ actionId: 'workspace.sync.relationship.flush', actionArgs }).title).toBe('Sync workspace now');
    });

    it('keeps authored plugin titles and summaries, even when they match first-party English copy', async () => {
        await preloadTranslations('fr');
        setPreferredLanguageFromSettings('fr');
        expect(presentActionApproval({ actionId: 'acme.publisher/actions/publish', authoredTitle: 'Create document public link',
            authoredSummary: 'Make a link that lets anyone who has it read a document.' }))
            .toEqual({ title: 'Create document public link', summary: 'Make a link that lets anyone who has it read a document.' });
        expect(presentActionApproval({ actionId: 'artifact.public_link.create', authoredSummary: 'My own explanation' }).summary)
            .toBe('My own explanation');
    });
});
