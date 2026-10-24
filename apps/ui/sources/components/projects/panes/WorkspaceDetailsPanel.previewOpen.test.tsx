import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { renderScreen, flushHookEffects } from '@/dev/testkit';
import { installSessionDetailsPanelNonRnModuleMocks } from '@/components/sessions/panes/sessionDetailsPanelNonRnModuleMocks';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol/local/services/preview/v1';
import { LocalServicePreviewServerAccessV1Schema } from '@happier-dev/protocol/local/services/preview/nativeDirect';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';

installSessionDetailsPanelNonRnModuleMocks();
installDisconnectedServerSocketBoundary();
const { WorkspaceDetailsPanel } = await import('./WorkspaceDetailsPanel');
const { DetailsSplitWorkspace } = await import('@/components/appShell/panes/details/workspace/DetailsSplitWorkspace');
const { createBrowserLaunchpadDetailsTab } = await import('@/components/browser/surfaces');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { resolveBrowserViewTargetOpenTab } = await import('@/components/browser/surfaces/openBrowserTargetInWorkspace');
const { publishLocalServicePreviewSnapshot } = await import('@/sync/domains/local/services/preview/sharedStore');
const accessUrl = 'https://project-preview.preview.test/nested?previewToken=admission';

describe('WorkspaceDetailsPanel preview opening', () => {
    it('opens the Project Home preview while another Home is focused', async () => {
        const homes = await serveAccountHomes({ homes: [
            { key: 'project', serverUrl: 'https://project-home.test', accountId: 'project-account' },
            { key: 'focused', serverUrl: 'https://focused-home.test', accountId: 'focused-account' },
        ], route: request => {
            if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') {
                return Response.json(createRootLayoutFeaturesResponse({ features: {
                    browser: { enabled: true, viewTargets: { enabled: true } },
                } }));
            }
            if (request.path === '/v1/local-services/preview/project-preview/access' && request.home === 'project') {
                return Response.json(LocalServicePreviewServerAccessV1Schema.parse({ v: 1, kind: 'server_preview',
                    previewId: 'project-preview', machineId: 'm1', accessUrl, expiresAt: Date.now() + 60_000 }));
            }
            return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        } });
        try {
            let pane: AppPaneScopeApi | undefined;
            function Probe() { pane = useAppPaneScope('project:wr_preview'); return null; }
            const resource = LocalServicePreviewResourceV1Schema.parse({
                previewId: 'project-preview', machineId: 'm1', owner: { kind: 'user', id: 'project-account' },
                target: { scheme: 'http', host: '127.0.0.1', port: 42511 },
                initialPath: { pathname: '/', search: '' }, originMode: 'host',
                display: { title: 'Project service', addressLabel: 'localhost:42511' },
                browserTarget: { kind: 'localServicePreview', targetId: 'project-preview', machineId: 'm1' },
            });
            publishLocalServicePreviewSnapshot({ machineId: 'm1', serverId: homes.homes.project!.id }, {
                generatedAt: Date.now(), refreshState: 'idle', diagnostics: [],
                previews: [{ previewId: resource.previewId, resource, accessUrl, expiresAt: Date.now() + 60_000, diagnostics: [] }],
            });
            const screen = await renderScreen(<AppPaneProvider><Probe /><WorkspaceDetailsPanel
                workspaceRef={{ id: 'wr_preview', serverId: homes.homes.project!.id, machineId: 'm1', rootPath: '/repo', createdAtMs: 1 }}
                scopeId="project:wr_preview" activeRootPath="/repo"
            /></AppPaneProvider>);
            const browserTab = resolveBrowserViewTargetOpenTab({
                scope: 'workspaceDetails', platform: 'web',
            }, resource.browserTarget!).tab;
            await act(async () => pane!.openDetailsTab(browserTab, { intent: 'pinned' }));
            await flushHookEffects({ cycles: 20 });
            expect(screen.tree.findAllByType('iframe').some(frame => {
                const src = new URL(frame.props.src);
                return src.origin === new URL(accessUrl).origin && src.pathname === '/nested';
            }), screen.getTextContent()).toBe(true);
            await act(async () => {
                pane!.openDetailsTab({ key: 'file:src/a.ts', kind: 'file', title: 'a.ts',
                    resource: { kind: 'file', path: 'src/a.ts' } }, { intent: 'preview', present: false });
                pane!.setActiveDetailsTab(browserTab.key);
            });
            expect(pane!.scopeState?.details.activeTabKey).toBe(browserTab.key);
            const renderTabContent = screen.findByType(DetailsSplitWorkspace).props.renderTabContent;
            const renderStripActions = screen.findByType(DetailsSplitWorkspace).props.renderStripActions;
            for (let index = 0; index < 20; index += 1) {
                await act(async () => {
                    pane!.patchDetailsTabState('file:src/a.ts', { accountId: 'project-account', isEditingFile: true,
                        editorOriginalHash: 'base-hash', editorText: `draft ${index}` }, { persist: false });
                    if (index === 0) pane!.pinDetailsTab('file:src/a.ts', { persist: false });
                });
            }
            expect(screen.findByType(DetailsSplitWorkspace).props.renderTabContent).toBe(renderTabContent);
            expect(screen.findByType(DetailsSplitWorkspace).props.renderStripActions).toBe(renderStripActions);
            await screen.pressByTestIdAsync('workspace-details-open-browser');
            expect(pane!.scopeState?.details.activeTabKey).toBe(createBrowserLaunchpadDetailsTab().key);
        } finally {
            await standardCleanup();
            await homes.dispose();
        }
    });
});
