import { describe, expect, it } from 'vitest';

import { resolveBrowserAnnotationCaptureCapability } from './annotationCaptureCapability';

describe('resolveBrowserAnnotationCaptureCapability (ANNO-6 engine matrix)', () => {
    it('does not admit desktop capture without a bound capture source', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'desktopWebView',
            captureSourceAvailable: false,
        });
        expect(cap).toEqual({ available: false, disabledReason: 'browser_context_annotation_capture_unavailable' });
    });

    it('admits desktop capture with a bound capture source', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'desktopWebView',
            captureSourceAvailable: true,
        });
        expect(cap).toEqual({ available: true, fidelity: 'nativeCallback' });
    });

    it('admits managed Chromium capture only with its bound capture source', () => {
        const gatedOff = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'chromiumSidecar',
            primaryEngine: 'unavailable',
            captureSourceAvailable: false,
        });
        expect(gatedOff.available).toBe(false);
        expect(gatedOff.available === false && gatedOff.disabledReason).toBe('browser_context_annotation_capture_unavailable');

        const gatedOn = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'chromiumSidecar',
            primaryEngine: 'unavailable',
            captureSourceAvailable: true,
        });
        expect(gatedOn).toEqual({ available: true, fidelity: 'cdp' });
    });

    it('web iframe engine is disabled with an explicit reason (not silently hidden)', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'externalUrl',
            primaryEngine: 'webIframe',
            captureSourceAvailable: false,
        });
        expect(cap.available).toBe(false);
        expect(cap.available === false && cap.disabledReason).toBe('browser_context_annotation_iframe_capture_unavailable');
    });

    it('react-native native webview engine is disabled with an explicit reason', () => {
        const cap = resolveBrowserAnnotationCaptureCapability({
            adapterKind: 'localPreview',
            primaryEngine: 'nativeWebView',
            captureSourceAvailable: false,
        });
        expect(cap.available).toBe(false);
        expect(cap.available === false && cap.disabledReason).toBe('browser_context_annotation_capture_unavailable');
    });

    it('simulator/streamed surfaces are disabled with an explicit reason', () => {
        for (const primaryEngine of ['streamedSurface', 'unavailable'] as const) {
            const cap = resolveBrowserAnnotationCaptureCapability({
                adapterKind: 'simulatorPreview',
                primaryEngine,
                captureSourceAvailable: false,
            });
            expect(cap.available).toBe(false);
        }
    });
});
