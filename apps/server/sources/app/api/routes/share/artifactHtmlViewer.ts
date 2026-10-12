/// <reference lib="dom" />

import { ARTIFACT_HTML_SANDBOX_V1, buildArtifactHtmlDocumentV1, type ArtifactHtmlBundleV1 } from '@happier-dev/protocol/sharing/public-viewer';
import type { UiSurfaceCapabilityRequestV1 } from '@happier-dev/protocol/plugins/contributions/ui/hostedHtmlCapabilitiesV1';

type ArtifactHtmlViewerOptions = Readonly<{
    requestedCapabilities?: UiSurfaceCapabilityRequestV1;
    networkOff?: boolean;
}>;

/** Opened bytes stay inside the opaque guest frame, never the application DOM. */
export function buildArtifactHtmlSrcdoc(bundle: ArtifactHtmlBundleV1, _document: Document, options: ArtifactHtmlViewerOptions = {}): string {
    return buildArtifactHtmlDocumentV1(bundle, options);
}

export function renderArtifactHtmlViewer(root: HTMLElement, bundle: ArtifactHtmlBundleV1, title: string, options: ArtifactHtmlViewerOptions = {}): void {
    const iframe = root.ownerDocument.createElement('iframe');
    iframe.setAttribute('sandbox', ARTIFACT_HTML_SANDBOX_V1);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('credentialless', '');
    iframe.title = title;
    iframe.style.cssText = 'border:0;width:100%;min-height:80vh;background:white';
    iframe.srcdoc = buildArtifactHtmlSrcdoc(bundle, root.ownerDocument, options);
    root.replaceChildren(iframe);
}
