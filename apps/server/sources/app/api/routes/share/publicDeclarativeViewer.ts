/// <reference lib="dom" />

import { createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HappierUiEnvironmentProvider, type HappierUiTheme } from '@happier-dev/plugin-ui/environment';
import { renderInertDeclarativeView, type InertDeclarativeLabels } from '@happier-dev/plugin-ui/declarative';
import { normalizeSessionSurfaceDeclarativeDocumentV1 } from '@happier-dev/protocol/sessions/board';

/** The isolated public shell follows browser system colours; app styling is host-owned. */
function readPublicViewerTheme(root: HTMLElement): HappierUiTheme {
    const fontSize = Number.parseFloat(root.ownerDocument.defaultView?.getComputedStyle(root).fontSize ?? '') || 16;
    const body = { fontSize, lineHeight: fontSize * 1.5, fontWeight: '400' };
    return {
        version: 1,
        colors: {
            canvas: 'Canvas', surface: 'Canvas', elevatedSurface: 'Canvas', text: 'CanvasText',
            secondaryText: 'CanvasText', mutedText: 'GrayText', border: 'GrayText', divider: 'GrayText',
            focus: 'Highlight', accent: 'Highlight', onAccent: 'HighlightText', success: 'CanvasText',
            warning: 'CanvasText', attention: 'CanvasText', danger: 'CanvasText', info: 'CanvasText',
            control: 'ButtonFace', controlDisabled: 'ButtonFace', overlay: 'Canvas',
        },
        spacing: { xsmall: 4, small: 8, medium: 12, large: 16, xlarge: 20 },
        radii: { small: 4, control: 8, panel: 12, pill: 999 },
        typography: { body, reading: body, label: body, title: body, caption: body, code: { ...body, fontFamily: 'monospace' } },
    };
}

/** The anonymous shell is not localized yet; its labels stay this viewer's English copy. */
const publicViewerLabels: InertDeclarativeLabels = { success: 'Success', warning: 'Warning', error: 'Error', incomplete: 'More in source' };

/** Anonymous content never receives author Actions, Resources, settings or targeted surfaces. */
export function buildPublicSessionDeclarativeView(document: unknown, theme: HappierUiTheme): ReactNode {
    const normalized = normalizeSessionSurfaceDeclarativeDocumentV1({ document, admittedHostActions: [] });
    return renderInertDeclarativeView(normalized.root, theme, publicViewerLabels);
}

/** Mount and dispose one visible public visual through the same portable traversal as the app. */
export function mountPublicSessionDeclarative(root: HTMLElement, document: unknown): () => void {
    const theme = readPublicViewerTheme(root);
    const view = buildPublicSessionDeclarativeView(document, theme);
    const browser = root.ownerDocument.defaultView;
    const renderer = createRoot(root);
    renderer.render(createElement(HappierUiEnvironmentProvider, {
        environment: {
            theme,
            localization: { locale: browser?.navigator.language ?? 'en', direction: root.dir === 'rtl' ? 'rtl' : 'ltr', translate: (_key, fallback) => fallback ?? '' },
            accessibility: { textScale: 1, reducedMotion: true, screenReaderEnabled: false, contrast: 'normal' },
            platform: { platform: 'web', colorScheme: browser?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' },
            insets: { safeArea: { top: 0, right: 0, bottom: 0, left: 0 } },
        },
        children: view,
    }));
    return () => renderer.unmount();
}
