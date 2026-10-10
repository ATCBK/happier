import * as React from 'react';

import { randomUUID } from '@/platform/randomUUID';
import type { WidgetGroupOperations } from '@/components/widgets/group/widgetGroupMenu';

import type { HomeHubLayout } from './useHomeHubLayout';

/**
 * Home's group operations, each one intent through the Home layout owner. Menu events consume the
 * rejection: the layout queue keeps a failed intent for Customize's Retry.
 */
export function useHomeWidgetGroupOperations(
  layout: Pick<
    HomeHubLayout,
    | 'setGroup'
    | 'setFrameStyle'
    | 'ungroup'
    | 'remove'
    | 'moveItem'
    | 'moveTo'
    | 'createGroup'
  >,
): WidgetGroupOperations {
  const { setGroup, setFrameStyle, ungroup, remove, moveItem, moveTo, createGroup } =
    layout;
  const quiet = (promise: Promise<void>) => {
    void promise.catch(() => {});
  };
  return React.useMemo(
    () => ({
      setWidth: (groupId, width) => quiet(setGroup(groupId, { width })),
      setFrame: (groupId, frameStyle) =>
        quiet(setFrameStyle(groupId, frameStyle)),
      setDividers: (groupId, dividers) =>
        quiet(setGroup(groupId, { dividers })),
      ungroup: (groupId) => quiet(ungroup(groupId)),
      remove: (groupId) => quiet(remove(groupId)),
      move: (instanceId, toIndex, groupId) =>
        quiet(groupId === null ? moveTo(instanceId, { nativeIndex: toIndex }) : moveItem(instanceId, toIndex, groupId)),
      create: (instanceIds) => quiet(createGroup(randomUUID(), instanceIds)),
    }),
    [createGroup, moveItem, moveTo, remove, setFrameStyle, setGroup, ungroup],
  );
}
