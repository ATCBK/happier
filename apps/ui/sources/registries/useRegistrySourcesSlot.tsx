import * as React from 'react';
import type { RegistryKindV1 } from '@happier-dev/protocol/registries';

import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';
import { t } from '@/text';

import {
  RegistrySourceSelect,
  type RegistrySourceSelection,
} from './RegistrySourceSelect';
import {
  RegistrySourcesView,
  type RegistrySourcesViewItemFromSource,
} from './RegistrySourcesView';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

export type RegistrySourcesSlot = Readonly<{
  sources: NonNullable<CapabilityAddModalConfig<unknown>['sources']>;
  selection: RegistrySourceSelection;
  /** What `useRegistryItems` reads for the selection: every source, or the one chosen. */
  sourceIds: readonly string[] | undefined;
  setSelection: (next: RegistrySourceSelection) => void;
}>;

/**
 * The one glue between P4's registry components and P5's Add-modal `sources` slot (P4 I-7): it owns the selection,
 * renders the select in the tools row and the Registries view one level in. A registry added from the view becomes
 * the selection and the modal returns to the catalog on it. Skills, MCP servers and Agents all call this.
 */
export function useRegistrySourcesSlot(
  kind: RegistryKindV1,
  opts?: Readonly<{
    itemsFromSource?: (
      sourceId: string,
    ) => readonly RegistrySourcesViewItemFromSource[];
    initialSelection?: RegistrySourceSelection;
    testID?: string;
  }>,
): RegistrySourcesSlot {
  const [selection, setSelection] = React.useState<RegistrySourceSelection>(
    opts?.initialSelection ?? 'all',
  );
  const itemsFromSource = opts?.itemsFromSource;
  const testID = opts?.testID ?? `registries.${kind}`;
  const sources = React.useMemo<RegistrySourcesSlot['sources']>(
    () => ({
      renderSelect: ({ openRegistries }) => (
        <RegistrySourceSelect
          kind={kind}
          value={selection}
          onChange={setSelection}
          onOpenRegistries={openRegistries}
          testID={`${testID}.select`}
        />
      ),
      // The modal's registries are a configuration body like the details: section descriptions read above their rows.
      renderRegistriesView: ({ intent, back }) => (
        <ListPresentationProvider value="page" pageInsets="contained">
          <RegistrySourcesView
            kind={kind}
            initialIntent={intent}
            {...(itemsFromSource ? { itemsFromSource } : {})}
            onSourceAdded={(sourceId) => {
              setSelection(sourceId);
              back();
            }}
            onBack={back}
            testID={`${testID}.view`}
          />
        </ListPresentationProvider>
      ),
      registriesHeader: {
        title: t('capabilities.registries.view.title'),
        subtitle: t('capabilities.registries.view.purpose', { kind }),
      },
    }),
    [itemsFromSource, kind, selection, testID],
  );
  const sourceIds = React.useMemo(
    () => (selection === 'all' ? undefined : [selection]),
    [selection],
  );
  return React.useMemo(
    () => ({ sources, selection, sourceIds, setSelection }),
    [selection, sourceIds, sources],
  );
}
