import * as React from 'react';
import { View } from 'react-native';
import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';
import { ARTIFACT_HTML_BUNDLE_MIME_V1, ArtifactHtmlBundleV1Schema } from '@happier-dev/protocol/artifacts/artifactHtmlV1';

import { createArtifactActionsClient } from '@/components/artifacts/artifactActionsClient';
import { DocumentShareSheet } from '@/components/sharing/documents/DocumentShareSheet';
import { runWidgetDefinitionCommand } from '@/components/widgets/definitions/widgetDefinitionCommands';
import { WidgetFlowPanel } from '@/components/widgets/flow/WidgetFlowPanel';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';

/** Explicit Session→Account copy. Public issuance stays in the existing share confirmation. */
export function SessionVisualCopyPanel(props: Readonly<{
    item: SessionSurfaceItemV1;
    itemId: string;
    sessionId: string;
    account: ServerAccountScope;
    share: boolean;
    onClose: () => void;
    testID: string;
}>): React.ReactElement {
    const [state, setState] = React.useState<'idle' | 'busy' | 'failed' | 'pending' | 'saved'>('idle');
    const [saved, setSaved] = React.useState<Readonly<{ artifactId: string; kind: 'html' | 'widget-definition.v1' }> | null>(null);
    const inFlight = React.useRef(false);
    const save = async () => {
        if (inFlight.current || saved || state === 'pending') return;
        inFlight.current = true;
        setState('busy');
        const artifactId = randomUUID();
        try {
            if (props.item.source.kind === 'hostedHtml') {
                const bundle = ArtifactHtmlBundleV1Schema.parse({ ...props.item.source.source,
                    requestedCapabilities: props.item.source.requestedCapabilities ?? { network: 'none' } });
                const result = await createArtifactActionsClient(props.account).createArtifact({ artifactId,
                    header: { kind: 'html', title: props.item.title ?? t('sessionBoard.item.untitled'), mime: ARTIFACT_HTML_BUNDLE_MIME_V1 },
                    body: JSON.stringify(bundle) });
                if ('approvalId' in result) { setState('pending'); return; }
                if (!result.ok) { setState('failed'); return; }
                setSaved({ artifactId: result.value.artifactId, kind: 'html' });
            } else {
                const result = await runWidgetDefinitionCommand('widgets.definition.saveFromSession', { account: props.account,
                    session: { serverId: props.account.serverId, sessionId: props.sessionId }, itemId: props.itemId, artifactId,
                    ...(props.item.title ? { name: props.item.title } : {}) }, props.account);
                if (result.kind === 'approvalPending') { setState('pending'); return; }
                if (result.kind !== 'applied') { setState('failed'); return; }
                setSaved({ artifactId, kind: 'widget-definition.v1' });
            }
            setState('saved');
        } catch { setState('failed'); }
        finally { inFlight.current = false; }
    };
    return <WidgetFlowPanel title={saved && props.share ? t('widgetDefinition.visualShareTitle') : t('widgetDefinition.visualSaveTitle')} hint={saved ? null : t('widgetDefinition.visualSaveHint')}
        testID={props.testID} onCancel={props.onClose}
        note={saved ? t('widgetDefinition.visualSavedCopy') : state === 'pending' ? t('widgetAdd.areaApprovalPending') : null}
        error={state === 'failed' ? t('widgetDefinition.visualSaveFailed') : null}
        primary={saved || state === 'pending' ? { label: t('common.done'), onPress: props.onClose }
            : { label: t('common.save'), testID: `${props.testID}.save`, onPress: () => { void save(); }, busy: state === 'busy' }}>
        {saved && props.share ? <View>
            <DocumentShareSheet artifactId={saved.artifactId} kind={saved.kind} scope={props.account} testID={`${props.testID}.share`} />
        </View> : null}
    </WidgetFlowPanel>;
}
