import * as React from 'react';
import { useWindowDimensions } from 'react-native';

import {
  HappierCapabilityAddBody,
  type HappierCapabilityAddConfig,
  type HappierCapabilityAddDetailFooter,
  type HappierCapabilityAddFound,
  type HappierCapabilityAddHost,
  type HappierCapabilityAddLabels,
  type HappierCapabilityAddLevel,
  type HappierCapabilityAddMode,
} from '../presentation/capabilities/CapabilityAddBody.js';
import { resolveHappierViewportClass } from '../presentation/layout/viewportClass.js';
import { Button, IconButton } from './Button.js';
import { Collection } from './Collection.js';
import { DetailsPaneFooter } from './DetailsPane.js';
import { Select } from './Form.js';
import { Banner } from './Foundation.js';
import { Icon, type IconName } from './Icon.js';
import { usePluginTheme, usePluginTranslation } from './PluginUiProvider.js';
import { Text } from './Text.js';

const ADD_KEY = 'happier.plugin-ui.capability.add';

export type CapabilityAddMode = HappierCapabilityAddMode<IconName>;
export type CapabilityAddConfig<Item> = HappierCapabilityAddConfig<Item, IconName>;
export type CapabilityAddFound<Found> = HappierCapabilityAddFound<Found>;
export type CapabilityAddDetailFooter = HappierCapabilityAddDetailFooter;
export type CapabilityAddLevel = HappierCapabilityAddLevel;
export type CapabilityAddBodyProps<Item> = Readonly<{
  config: CapabilityAddConfig<Item>;
  /** The person is done (Done, an added item that closes, a mode that hands off). */
  onClose: () => void;
  /** Where the body stands: show the way back in your page or sheet header for `detail` and `registries`. */
  onLevelChange?: (level: CapabilityAddLevel) => void;
}>;

const PUBLIC_ADD_SLOTS: HappierCapabilityAddHost<IconName> = {
  Collection,
  DetailsFooter: DetailsPaneFooter,
  ModeTabs: ({ modes, activeKey, onSelect, narrow, accessibilityLabel, testID }) => (
    <Select
      testID={`${testID}:modes`}
      label={accessibilityLabel}
      presentation="segmented"
      options={modes.map((mode) => ({ value: mode.key, label: mode.label, ...(narrow ? {} : { icon: mode.icon }) }))}
      value={activeKey}
      onChange={(next) => onSelect(String(next))}
    />
  ),
  Button: ({ title, display, loading, disabled, onPress, testID }) => (
    <Button
      title={title}
      variant={display}
      {...(loading === undefined ? {} : { busy: loading })}
      {...(disabled === undefined ? {} : { disabled })}
      onPress={onPress}
      testID={testID}
    />
  ),
  CloseDetail: ({ accessibilityLabel, onPress, testID }) => (
    <IconButton accessibilityLabel={accessibilityLabel} icon={<Icon name="close" size="small" tone="secondary" />} onPress={onPress} testID={testID} />
  ),
  SourceFailure: ({ title, retryLabel, onRetry, retryTestID, testID }) => (
    <Banner
      tone="warning"
      presentation="strip"
      title={title}
      action={<Button variant="secondary" size="small" title={retryLabel} onPress={onRetry} testID={retryTestID} />}
      testID={testID}
    />
  ),
  ErrorText: ({ children, testID }) => (
    <Text variant="meta" tone="danger" testID={testID}>
      {children}
    </Text>
  ),
};

/**
 * The Add body for a plugin's own installable things, inside the plugin's own page or sheet: the ways to add as tabs,
 * the catalog list with details beside it (pushed on a phone), the pinned footer and the registry selector — the same
 * body Happier's Add a skill, Add a server and Add an agent dialogs draw. The frame and its header stay yours.
 */
export function CapabilityAddBody<Item>(props: CapabilityAddBodyProps<Item>): React.ReactElement {
  const translate = usePluginTranslation();
  const theme = usePluginTheme();
  const { width, height } = useWindowDimensions();
  const labels = React.useMemo<HappierCapabilityAddLabels>(
    () => ({
      modesLabel: translate(`${ADD_KEY}.modesLabel`, 'Ways to add'),
      searchLabel: translate(`${ADD_KEY}.searchLabel`, 'Search'),
      retry: translate(`${ADD_KEY}.retry`, 'Retry'),
      closeDetails: translate(`${ADD_KEY}.closeDetails`, 'Close details'),
      added: translate(`${ADD_KEY}.added`, 'Added'),
      done: translate(`${ADD_KEY}.done`, 'Done'),
      addFailed: translate(`${ADD_KEY}.addFailed`, 'Couldn’t add it. Try again.'),
    }),
    [translate],
  );
  return (
    <HappierCapabilityAddBody
      config={props.config}
      onClose={props.onClose}
      {...(props.onLevelChange === undefined ? {} : { onLevelChange: props.onLevelChange })}
      phone={resolveHappierViewportClass({ width, height }) === 'compact'}
      labels={labels}
      host={PUBLIC_ADD_SLOTS}
      hairlineColor={theme.colors.border}
    />
  );
}
