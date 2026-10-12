import {
  artifactHtmlBundleFromBodyV1,
  type ArtifactHtmlBundleV1,
  type PluginUiActionInputFor,
} from '@happier-dev/plugin-sdk/ui';

/** Public producer-derived Action input: no host imports or installed-plugin impersonation. */
export const externalTableVisual = {
  sessionId: 'external-visual-session', itemId: 'measurements', expectedItemRevision: null,
  destination: 'transcript', item: {
    v: 1, title: 'Measurements', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: {
      kind: 'table', label: 'Measurements', data: { kind: 'value', value: [{ sample: 'Copper', measured: 0.000017 }] },
      rows: [], columns: [
        { label: 'Sample', field: { path: ['sample'], type: 'string' } },
        { label: 'Amount', field: { path: ['measured'], type: 'number' } },
      ],
    } } },
  },
} satisfies PluginUiActionInputFor<'session.board.item.upsert'>;

/** The same admitted chart document can be shown inline or placed on the Board. */
export const externalChartVisual = {
  sessionId: 'external-visual-session', itemId: 'rainfall', expectedItemRevision: null,
  destination: 'transcript', item: {
    v: 1, title: 'Rainfall', frame: 'frameless', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'declarative', document: { version: 1, root: {
      kind: 'chart', label: 'Rainfall', style: 'bar', rows: [],
      data: { kind: 'value', value: [{ day: 'Thu', station: 'North', rain: 0.00004 },
        { day: 'Thu', station: 'South', rain: 7 }, { day: 'Fri', station: 'South', rain: 0 }] },
      x: { path: ['day'], type: 'string' }, series: { path: ['station'], type: 'string' }, value: { path: ['rain'], type: 'number' },
    } } },
  },
} satisfies PluginUiActionInputFor<'session.board.item.upsert'>;

// This convenience helper returns the canonical bundle, not an HTML-string surface source.
export const externalHtmlBundle: ArtifactHtmlBundleV1 = artifactHtmlBundleFromBodyV1('<main>External author visual</main>');
export const externalHtmlVisual = {
  sessionId: 'external-visual-session', itemId: 'html-preview', expectedItemRevision: null,
  destination: 'transcript', item: {
    v: 1, title: 'HTML preview', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
    source: { kind: 'hostedHtml', source: externalHtmlBundle },
  },
} satisfies PluginUiActionInputFor<'session.board.item.upsert'>;
