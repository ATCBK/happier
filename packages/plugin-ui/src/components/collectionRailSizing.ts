import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import type { HappierCollectionRailSizingProps } from '../presentation/collection/useResizableListDetailGeometry.js';
import { usePluginTranslation } from './PluginUiProvider.js';

const noWidth = () => null;

export function useCollectionRailLabels(labels?: Readonly<{ resize: string; resizeHint?: string; resizeValue?: (px: number) => string }>) {
  const translate = usePluginTranslation();
  return labels ?? {
    resize: translate('happier.plugin-ui.resize.label', 'Resize column'),
    resizeHint: translate('happier.plugin-ui.resize.hint', 'Drag or use the arrow keys to resize'),
    resizeValue: (px: number) => translate('happier.plugin-ui.resize.value', '{px} pixels').replace('{px}', String(px)),
  };
}

/** The host binding is stable for a mounted surface, just like its details-pane binding. */
export function useCollectionRailSizing(props: HappierCollectionRailSizingProps): HappierCollectionRailSizingProps {
  const port = useOptionalPluginUiPresentationHost()?.panelSizing;
  const useWidth = port?.useWidth ?? noWidth;
  const stored = useWidth(props.resizeKey ?? '');
  if (props.resizeKey === undefined || !stored) return props;
  return {
    ...props,
    listWidthPx: props.listWidthPx ?? stored.widthPx,
    onListWidthCommit: width => { stored.commit(width); props.onListWidthCommit?.(width); },
    onListWidthReset: () => { stored.reset(); props.onListWidthReset?.(); },
  };
}
