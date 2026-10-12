import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { HAPPIER_FIELD_BOX_METRICS, HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { ArtifactHeaderMetadataV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { CodeEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { MarkdownCodeEditorField } from '@/components/ui/markdown/editor/MarkdownCodeEditorField';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { resolveItemGroupContentHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { PageContentColumn } from '@/components/ui/lists/PageContentColumn';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Modal } from '@/modal';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { safeRouterBack } from '@/utils/navigation/safeRouterBack';

import { artifactViewRoute } from './artifactBrowserModel';
import { useArtifactActionsClient, type ArtifactQuota } from './artifactActionsClient';
import { ArtifactQuotaNotice } from './ArtifactQuotaNotice';
import { ArtifactView } from './ArtifactView';

/**
 * Writing a document: its title edited in the page header, its Markdown below, one Save. A save the
 * server refuses for a budget keeps every edit and names the size and the cap (lab A8p).
 */
export function ArtifactEditor(props: Readonly<{ artifact: DecryptedArtifact | null; mode: 'new' | 'edit' }>): React.ReactElement {
    const router = useRouter();
    const { artifact, mode } = props;
    const client = useArtifactActionsClient();
    const scope = useActiveServerAccountScope();
    // Draft fields, metadata and CAS belong to the same opening read, never a later socket head.
    const [opening] = React.useState(artifact);
    const [title, setTitle] = React.useState(artifact?.title ?? '');
    const [body, setBody] = React.useState(typeof artifact?.body === 'string' ? artifact.body : '');
    const bodyRef = React.useRef(body);
    bodyRef.current = body;
    const [saving, setSaving] = React.useState(false);
    const [quota, setQuota] = React.useState<ArtifactQuota | null>(null);
    const [conflict, setConflict] = React.useState(false);
    const editorRef = React.useRef<CodeEditorHandle | null>(null);
    // A new document starts with the cursor in its source, as the field did.
    React.useEffect(() => { if (mode === 'new') editorRef.current?.focus?.(); }, [mode]);
    const changed = mode === 'new'
        ? title.trim().length > 0 || body.trim().length > 0
        : title !== (opening?.title ?? '') || body !== (opening?.body ?? '');

    const save = React.useCallback(async () => {
        if (saving || !changed) return;
        // The editor may still hold a debounced keystroke: save what is on screen.
        await editorRef.current?.flushPendingChange();
        const body = editorRef.current?.getValue() ?? bodyRef.current;
        if (!title.trim() && !body.trim()) {
            await Modal.alert(t('common.error'), t('artifacts.emptyFieldsError'));
            return;
        }
        setSaving(true);
        setQuota(null);
        try {
            if (!client || (mode === 'edit' && (!opening?.isDecrypted || !opening.rawHeader || opening.bodyVersion === undefined))) {
                throw new Error('artifact_content_unavailable');
            }
            const header = ArtifactHeaderMetadataV1Schema.parse({ ...(mode === 'edit' ? opening?.rawHeader : {}), title: title.trim() || null });
            const outcome = mode === 'new'
                ? await client.createArtifact({ header, body: body.trim() })
                : await client.updateArtifact({ artifactId: opening!.id, header, body: body.trim(),
                    expectedRevision: { headerVersion: opening!.headerVersion, bodyVersion: opening!.bodyVersion! } });
            if ('approvalId' in outcome) {
                if (scope) router.push(`/inbox/approvals/${encodeURIComponent(outcome.approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` as never);
                return;
            }
            if (!outcome.ok) {
                if (outcome.failure.quota) { setQuota(outcome.failure.quota); return; }
                if (outcome.failure.code === 'version_mismatch') { setConflict(true); return; }
                throw new Error(outcome.failure.code);
            }
            if (mode === 'new') router.replace(artifactViewRoute(outcome.value.artifactId) as never);
            else safeRouterBack({ router, fallbackHref: '/artifacts' });
        } catch {
            await Modal.alert(t('common.error'), mode === 'new' ? t('artifacts.createError') : t('artifacts.updateError'));
        } finally {
            setSaving(false);
        }
    }, [opening, changed, client, mode, router, saving, scope, title]);

    const cancel = React.useCallback(async () => {
        if (changed && !(await Modal.confirm(t('artifacts.discardChanges'), t('artifacts.discardChangesDescription'),
            { cancelText: t('common.keepEditing'), confirmText: t('common.discard'), destructive: true }))) return;
        safeRouterBack({ router, fallbackHref: '/artifacts' });
    }, [changed, router]);

    // The source fills the window from its own top down (lab A8p) and scrolls inside, as an editor does.
    const [viewportHeight, setViewportHeight] = React.useState<number | null>(null);
    const [bodyTop, setBodyTop] = React.useState<number | null>(null);
    const measureViewport = React.useCallback((event: LayoutChangeEvent) => setViewportHeight(event.nativeEvent.layout.height), []);
    const measureBodyTop = React.useCallback((event: LayoutChangeEvent) => setBodyTop(event.nativeEvent.layout.y), []);
    const bodyHeight = viewportHeight === null || bodyTop === null ? MIN_BODY_HEIGHT_PX
        : Math.max(MIN_BODY_HEIGHT_PX, viewportHeight - bodyTop - HAPPIER_PAGE_METRICS.pagePaddingBottomPx);
    const bodyFrame = React.useMemo(() => ({ height: bodyHeight }), [bodyHeight]);

    // A direct edit URL must not reinterpret a binary body as an empty Markdown document.
    if (mode === 'edit' && opening?.body !== null && typeof opening?.body === 'object') {
        return <ArtifactView artifactId={opening.id} artifact={opening} presentation="page" />;
    }

    return (
        <ItemList testID={`artifact-editor:${mode}`} onLayout={measureViewport}>
            <PageHeader
                testID="artifact-editor:header"
                title={title || t('artifacts.untitled')}
                alwaysShowTitle
                titleEditor={{
                    value: title,
                    placeholder: t('artifacts.untitled'),
                    accessibilityLabel: t('artifacts.titlePlaceholder'),
                    onChangeText: setTitle,
                    testID: 'artifact-editor:title',
                }}
                primaryAction={{ title: t('artifacts.save'), onPress: save, disabled: !changed, loading: saving, testID: 'artifact-editor:save' }}
                cancelAction={{ title: t('common.cancel'), onPress: cancel, testID: 'artifact-editor:cancel' }}
            />
            {/* A refusal is the page's one notice, in the document's column on the sections' edges (lab A8p). */}
            {conflict ? (
                <AttentionBanner testID="artifact-editor:conflict" tone="warning" announce="alert"
                    title={t('artifacts.browser.conflict.title')} description={t('artifacts.browser.conflict.body')} />
            ) : null}
            {quota ? <ArtifactQuotaNotice testID="artifact-editor:quota" quota={quota} /> : null}
            {/* The source is the page (lab A8p): on the canvas, unframed, filling the window below the header. */}
            {/* The app's one Markdown source editor (Prompts, Skills and Board notes use it too). */}
            <View onLayout={measureBodyTop}>
                <PageContentColumn style={BODY_INSET}>
                    <View style={bodyFrame}>
                        <MarkdownCodeEditorField
                            testID="artifact-editor:body"
                            resetKey={opening?.id ?? 'new'}
                            value={body}
                            language="markdown"
                            onChange={setBody}
                            editorRef={editorRef}
                            presentation="canvas"
                        />
                    </View>
                </PageContentColumn>
            </View>
        </ItemList>
    );
}

/** The source never draws shorter than a short note (sixteen field lines), even in a short window. */
const MIN_BODY_HEIGHT_PX = 16 * HAPPIER_FIELD_BOX_METRICS.lineHeightPx;
/** On the sections' text edge, like the notices above it. */
const BODY_INSET = { paddingHorizontal: resolveItemGroupContentHorizontalInsetPx() } as const;
