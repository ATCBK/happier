import { createElement, type ReactNode } from 'react';
import { PluginDeclarativeNodeV2Schema } from '@happier-dev/plugin-sdk/ui';
import {
  readPluginDeclarativeDataFieldV1,
  readPluginDeclarativeDataRowsV1,
} from '@happier-dev/plugin-sdk/ui';

import type { HappierUiTheme } from '../environment/index.js';
import { HappierMarkdown } from '../presentation/content/Markdown.js';
import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { HappierText } from '../presentation/text/Text.js';
import {
  readDeclarativeText,
  renderDeclarativeNode,
  type DeclarativeRenderingHost,
} from './declarativeNodes.js';

/** Host copy an anonymous reader needs; the host localizes it, the renderer never invents it. */
export type InertDeclarativeLabels = Readonly<{
  success: string;
  warning: string;
  error: string;
  incomplete: string;
}>;

function createInertRenderingHost(
  labels: InertDeclarativeLabels,
): DeclarativeRenderingHost {
  return {
    Text: HappierText,
    renderIcon: () => null,
    renderMarkdown: (input) => createElement(HappierMarkdown, input),
    renderSpinner: (color) =>
      createElement(HappierSpinner, { color, animationEnabled: false }),
    toneAccessibilityLabel: (tone) =>
      tone === 'success'
        ? labels.success
        : tone === 'warning'
          ? labels.warning
          : tone === 'danger'
            ? labels.error
            : null,
    incompleteText: labels.incomplete,
    readDataNode: (value) => {
      const parsed = PluginDeclarativeNodeV2Schema.safeParse(value);
      return parsed.success ? parsed.data : null;
    },
    readDataField: readPluginDeclarativeDataFieldV1,
    readDataRows: readPluginDeclarativeDataRowsV1,
    renderAction: () => null,
  };
}

/**
 * Renders an already-admitted inert document for a reader with no Account: no Actions, settings,
 * Resources, collections or targeted surfaces. Public Session visuals and public profile blocks share
 * this one traversal so an anonymous page never grows a second renderer.
 */
export function renderInertDeclarativeView(
  root: unknown,
  theme: HappierUiTheme,
  labels: InertDeclarativeLabels,
): ReactNode {
  return renderDeclarativeNode(root, {
    host: createInertRenderingHost(labels),
    presentationTheme: theme,
    minimumTouchTarget: 0,
    localize: readDeclarativeText,
    resolveAction: () => null,
    renderField: () => null,
    renderCollectionList: () => null,
  });
}
