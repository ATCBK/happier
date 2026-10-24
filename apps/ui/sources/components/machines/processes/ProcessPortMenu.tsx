import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { publishPresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import {
  copyLocalServiceAddress,
  resolveLocalServiceEntryActions,
} from '@/components/sessions/localServices/localServiceEntryActions';
import {
  useLocalServiceActionRunner,
  type LocalServiceActionRunner,
} from '@/components/sessions/localServices/localServiceActionOutcome';
import { resolveLocalServicePublicLinkOffer } from '@/components/sessions/localServices/LocalServicePublicPreviewControls';
import {
  useLocalServiceEntryActions,
  type LocalServiceEntryActionsWiring,
} from '@/components/sessions/localServices/useLocalServiceEntryActions';
import { useLocalServiceLiveFeeds } from '@/components/sessions/localServices/useLocalServiceLiveFeeds';
import {
  useLocalServicePresentationFeatures,
  type LocalServiceCapabilityDisabledReasons,
} from '@/components/sessions/localServices/useLocalServicePublicPreviewFeature';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Typography } from '@/constants/Typography';
import { selectLocalServiceInventoryRows } from '@/sync/domains/local/services/inventory/store';
import { selectLocalServiceLaunchTargets } from '@/sync/domains/local/services/launch';
import { useLocalServicePublicPreviewStateController } from '@/sync/domains/local/services/publicPreview/useLocalServicePublicPreviewState';
import {
  buildLocalServiceRows,
  selectLocalServiceRowForInventoryEntry,
  type ServiceRow,
} from '@/sync/domains/local/services/serviceRow';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import {
  bindServicesOpenInBrowser,
  type OpenBrowserViewTarget,
} from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { resolveBrowserSurfacePlatform } from '@/components/browser/surfaces/useBrowserSurfaceHostProps';
import type { ServiceRowOpenHandler } from '@/components/sessions/localServices/ServiceRowView';
import type { LocalServicePreviewState } from '@/sync/domains/local/services/preview/store';
import { useLocalServicePreviewState } from '@/sync/domains/local/services/preview/useLocalServicePreviewState';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

import { showProcessConfirmDialog } from './ProcessConfirmDialog';
import {
  processPortClosesTerminal,
  type ProcessesItem,
} from './processesPresentation';
import { ProcessesControllerContext } from './useProcessesController';

/** The machine's Local services, read once a port is first pressed and kept while the tab is open. */
type PortServices = Readonly<{
  /** `null` until the launcher's first snapshot arrives. */
  rows: readonly ServiceRow[] | null;
  handlers: LocalServiceEntryActionsWiring['handlers'];
  run: LocalServiceActionRunner['run'];
  publicPreviewEnabled: boolean;
  capabilityDisabledReasons: LocalServiceCapabilityDisabledReasons;
  /** Open in browser: the Services opener, ending in an external tab (the machine page hosts no browser pane). */
  openInBrowser: ServiceRowOpenHandler;
  /** The private-preview access owner's registrations: whether Open can reach a preview from here. */
  previews: LocalServicePreviewState;
}>;

const unopenable = (errorCode: string): ActionExecuteResult => ({
  ok: false,
  errorCode,
  error: errorCode,
});

/**
 * The external-tab end of the Services opener. Registration, mapping and the access route stay the
 * Services owner's (`bindServicesOpenInBrowser`); the URL is the one it admits for this viewer — the
 * preview's access URL — never the service's raw address. No access URL means no route from here.
 */
const openInExternalTab: OpenBrowserViewTarget = async (target, options) => {
  const url = target.kind === 'externalUrl' ? target.url : options?.currentUrl;
  if (!url) return unopenable('preview_private_route_unavailable');
  return (await openExternalUrl(url))
    ? { ok: true, result: null }
    : unopenable('browser_adapter_unavailable');
};

type PortActions = Readonly<{
  serverId: string;
  /** The one intent signal: the first press on any port starts the Local services feeds. */
  demand: () => void;
  services: PortServices | null;
}>;

const ProcessPortActionsContext = React.createContext<PortActions | null>(null);

/**
 * Lets the tab's port chips act through Local services (plan 30 U8, RU-3). Nothing is read until a
 * chip is pressed; from then on the machine's feeds and the shared Action admission stay mounted with
 * the tab, so an Action waiting on approval or a review outlives the menu that started it.
 */
export function ProcessPortActionsProvider(
  props: Readonly<{
    serverId: string;
    machineId: string;
    children: React.ReactNode;
  }>,
) {
  const [demanded, setDemanded] = React.useState(false);
  const [services, setServices] = React.useState<PortServices | null>(null);
  const demand = React.useCallback(() => setDemanded(true), []);
  const value = React.useMemo(
    () => ({ serverId: props.serverId, demand, services }),
    [demand, props.serverId, services],
  );
  return (
    <ProcessPortActionsContext.Provider value={value}>
      {demanded ? (
        <PortServicesHost
          serverId={props.serverId}
          machineId={props.machineId}
          onServices={setServices}
        />
      ) : null}
      {props.children}
    </ProcessPortActionsContext.Provider>
  );
}

function PortServicesHost(
  props: Readonly<{
    serverId: string;
    machineId: string;
    onServices: (services: PortServices | null) => void;
  }>,
) {
  const feeds = useLocalServiceLiveFeeds({
    machineId: props.machineId,
    serverId: props.serverId,
    scope: 'machine',
  });
  const wiring = useLocalServiceEntryActions({
    machineId: props.machineId,
    serverId: props.serverId,
    scope: 'machine',
    onRefresh: feeds.refresh,
    applyLauncherSnapshot: feeds.applyLauncherSnapshot,
    testID: 'machine-processes-port-services',
  });
  const runner = useLocalServiceActionRunner();
  const { publicPreviewFeatureEnabled: publicPreviewEnabled, publicPreviewCapabilityDisabledReasons: capabilityDisabledReasons } = useLocalServicePresentationFeatures(props.serverId);
  const previews = useLocalServicePreviewState({
    machineId: props.machineId,
    serverId: props.serverId,
  });
  const openInBrowser = React.useMemo(
    () =>
      bindServicesOpenInBrowser({
        onOpenTarget: openInExternalTab,
        platform: resolveBrowserSurfacePlatform(),
        serverId: props.serverId,
      }),
    [props.serverId],
  );
  const { inventoryState, launcherState } = feeds;
  const rows = React.useMemo(
    () =>
      launcherState && launcherState.updatedAt !== null
        ? buildLocalServiceRows({
            inventoryRows: selectLocalServiceInventoryRows(inventoryState),
            launchTargets: selectLocalServiceLaunchTargets(launcherState),
            sessionId: null,
            scope: 'machine',
          })
        : null,
    [inventoryState, launcherState],
  );
  const services = React.useMemo(
    (): PortServices => ({
      rows,
      handlers: wiring.handlers,
      run: runner.run,
      publicPreviewEnabled,
      capabilityDisabledReasons,
      openInBrowser,
      previews,
    }),
    [
      capabilityDisabledReasons,
      openInBrowser,
      previews,
      publicPreviewEnabled,
      rows,
      runner.run,
      wiring.handlers,
    ],
  );
  const { onServices } = props;
  React.useEffect(() => {
    onServices(services);
  }, [onServices, services]);
  React.useEffect(() => () => onServices(null), [onServices]);
  // A Start/Restart review never starts from a port; this keeps the shared admission's review placed.
  return wiring.review;
}

type PortEntry = DropdownMenuItem & Readonly<{ run?: () => void }>;

/**
 * A listener on the process that owns it (`:5173`). Pressed, it opens what Local services already
 * offers for that listener (lab `rp` F cell 4): Open in browser, Copy address, Public link…, then Stop. Read-only
 * surfaces (the Overview's "Using the most", the detail facts) and a tab with no controller draw the
 * chip alone.
 */
export const ProcessPortChip = React.memo(function ProcessPortChip(
  props: Readonly<{
    port: number;
    inventoryEntryId: string;
    item: ProcessesItem;
    /** The owner's title: a terminal's name when freeing this port closes it (R42.5). */
    ownerTitle: string;
  }>,
) {
  const language = usePreferredLanguage();
  const actions = React.useContext(ProcessPortActionsContext);
  const controller = React.useContext(ProcessesControllerContext);
  const [open, setOpen] = React.useState(false);
  const services = actions?.services ?? null;
  const row =
    open && services?.rows
      ? selectLocalServiceRowForInventoryEntry(services.rows, {
          inventoryEntryId: props.inventoryEntryId,
          port: props.port,
        })
      : null;
  // The row's public-link feed is read only while its menu is open.
  const preview = useLocalServicePublicPreviewStateController({
    machineId: row?.target.machineId ?? null,
    serverId: actions?.serverId ?? null,
    sessionId: row?.target.sessionId ?? null,
    enabled: row !== null && services?.publicPreviewEnabled === true,
  });
  const label = `:${props.port}`;
  const chip = (
    <StatusPill
      variant="neutral"
      hideDot
      label={label}
      labelStyle={styles.mono}
    />
  );

  const entries = React.useMemo((): readonly PortEntry[] => {
    if (!open || !controller) return [];
    if (!services?.rows) {
      return [{ id: 'loading', title: t('common.loading'), disabled: true }];
    }
    if (!row) {
      return [
        {
          id: 'not-listed',
          title: t('machineProcesses.portMenu.notListed'),
          disabled: true,
        },
      ];
    }
    const { handlers, run } = services;
    const offered = resolveLocalServiceEntryActions(
      row,
      { ...handlers, onOpenServiceInBrowser: services.openInBrowser },
      services.previews,
    );
    const blocked = controller.unavailableReason;
    const list: PortEntry[] = [];
    const openTarget = offered.open;
    if (openTarget) {
      const subtitle = blocked ?? offered.openUnavailableReason ?? undefined;
      list.push({
        id: 'open-browser',
        category: 'service',
        title: t('machineProcesses.portMenu.openInBrowser'),
        ...(subtitle ? { subtitle } : {}),
        disabled: subtitle !== undefined,
        run: () =>
          fireAndForget(
            run({
              id: `port:${props.inventoryEntryId}:open`,
              failureTitle: t('localServices.actions.failureTitle.open', {
                service: row.title,
              }),
              action: async () => services.openInBrowser(openTarget),
            }),
            { tag: 'MachineProcesses.portOpen' },
          ),
      });
    }
    const address = offered.address;
    if (address) {
      list.push({
        id: 'copy',
        category: 'service',
        title: t('localServices.pane.copyAddress'),
        subtitle: address,
        run: () =>
          fireAndForget(
            copyLocalServiceAddress(
              row.target,
              address,
              handlers.onCopyServiceUrl,
              setClipboardStringSafe,
            ).then((copied) => {
              if (copied)
                publishPresentationNotice({
                  key: 'machine-processes:copied',
                  severity: 'info',
                  message: t('machineProcesses.results.copied'),
                });
            }),
            { tag: 'MachineProcesses.portCopy' },
          ),
      });
    }
    const publicPreviewActions = handlers.publicPreviewActions;
    const link = publicPreviewActions
      ? resolveLocalServicePublicLinkOffer({
          state: services.publicPreviewEnabled ? preview.state : null,
          launchTarget: row.target,
          capabilityDisabledReasons: services.capabilityDisabledReasons,
        })
      : null;
    if (link && publicPreviewActions) {
      const subtitle =
        blocked ?? (link.kind === 'disabled' ? link.subtitle : undefined);
      list.push({
        id: 'public-link',
        category: 'service',
        title: t('machineProcesses.portMenu.publicLink'),
        ...(subtitle ? { subtitle } : {}),
        disabled: blocked !== null || link.kind === 'disabled',
        ...(link.kind === 'create'
          ? {
              run: () =>
                fireAndForget(link.request(publicPreviewActions, run), {
                  tag: 'MachineProcesses.portPublicLink',
                }),
            }
          : {}),
      });
    }
    const managed = offered.stopManaged;
    if (managed || offered.terminateDetected) {
      const frees = props.item.memoryBytes
        ? t('machineProcesses.menu.freesAbout', {
            amount: formatMachineBytes(props.item.memoryBytes, 'memory'),
          })
        : undefined;
      const subtitle = blocked ?? frees;
      const closesTerminal = processPortClosesTerminal(props.item);
      list.push({
        id: 'stop',
        category: 'stop',
        title: managed
          ? t('machineProcesses.menu.stopService')
          : t('machineProcesses.portMenu.stopServer', { port: props.port }),
        ...(subtitle ? { subtitle } : {}),
        disabled: blocked !== null,
        run: () =>
          fireAndForget(
            (async () => {
              // Policy owns whether to ask; this invocation supplies its terminal-loss facts.
              const confirmation = closesTerminal ? async () => {
                const decision = await showProcessConfirmDialog({
                  testID: 'machine-processes-port-close-terminal',
                  title: t('machineProcesses.portMenu.closeTerminalTitle', {
                    port: props.port,
                  }),
                  paragraphs: [
                    t('machineProcesses.portMenu.closesTerminal', {
                      name: props.ownerTitle,
                    }),
                    t('machineProcesses.portMenu.closeTerminalBody'),
                  ],
                  facts: [],
                  confirmLabel: t(
                    'machineProcesses.portMenu.confirmCloseTerminal',
                  ),
                });
                return decision === 'confirm';
              } : undefined;
              await run({
                id: `port:${props.inventoryEntryId}`,
                failureTitle: managed
                  ? t('localServices.actions.failureTitle.stop', {
                      service: row.title,
                    })
                  : t('localServices.actions.failureTitle.terminate', {
                      service: row.title,
                    }),
                action: async () =>
                  managed
                    ? handlers.onStopManagedService?.(row.target, { confirmation })
                    : handlers.onTerminateDetectedService?.(row.target, { confirmation }),
              });
            })(),
            { tag: 'MachineProcesses.portStop' },
          ),
      });
    }
    return list;
  }, [
      language,
    controller,
    open,
    preview.state,
    props.inventoryEntryId,
    props.item,
    props.ownerTitle,
    props.port,
    row,
    services,
  ]);

  const onSelect = React.useCallback(
    (id: string) => {
      setOpen(false);
      entries.find((entry) => entry.id === id)?.run?.();
    },
    [entries],
  );

  if (!actions || !controller) return chip;
  const demand = actions.demand;
  return (
    <DropdownMenu
      testID={`machine-processes-port-menu-${props.item.key}-${props.port}`}
      open={open}
      onOpenChange={setOpen}
      items={entries}
      onSelect={onSelect}
      matchTriggerWidth={false}
      placement="bottom"
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('machineProcesses.portMenu.label', {
        port: props.port,
      })}
      trigger={({ toggle }) => (
        <Pressable
          testID={`machine-processes-port-${props.item.key}-${props.port}`}
          accessibilityRole="button"
          accessibilityLabel={t('machineProcesses.portMenu.label', {
            port: props.port,
          })}
          onPress={() => {
            demand();
            toggle();
          }}
        >
          {chip}
        </Pressable>
      )}
    />
  );
});

const styles = StyleSheet.create(() => ({
  mono: {
    ...Typography.mono(),
  },
}));
