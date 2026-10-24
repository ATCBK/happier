import type {
  TargetedContributionPointRef,
  TargetedContributionSnapshot,
  TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type { PluginTestkit } from '@happier-dev/plugin-sdk/testing';

import { CHANNELS_PROVIDER_POINT_REF } from '../manifest.js';

/**
 * Explicit adapter for operation-only test composition, defaulting to Channels
 * V1. Descriptor admission is covered by the production CLI owner; these tests
 * do not consume provider presentation. The public testkit does not install this as a normal
 * service: production cold admission remains covered by the CLI owner, while
 * these operation-composition tests consume only the structural operation
 * handles the testkit can honestly issue.
 */
export function channelsOperationOnlyTargetedContributionsFixture(
  target: PluginTestkit,
  expectedPoint: TargetedContributionPointRef<unknown> = CHANNELS_PROVIDER_POINT_REF,
): TargetedContributionsService {
  return Object.freeze({
    observeForSelf<TContribution>(
      point: TargetedContributionPointRef<TContribution>,
      _options: Readonly<{ onInvalidated: () => void }>,
    ) {
      if (point.targetPluginId !== expectedPoint.targetPluginId
        || point.id !== expectedPoint.id
        || point.protocol.id !== expectedPoint.protocol.id
        || point.protocol.version !== expectedPoint.protocol.version) {
        throw new TypeError('The structural fixture only supports its selected operation-only point.');
      }
      return Object.freeze({
        dispose() {},
        async readCurrent(options?: Readonly<{ signal?: AbortSignal }>) {
          options?.signal?.throwIfAborted();
          const snapshot = target.readTargetedContributionFixture(expectedPoint);
          options?.signal?.throwIfAborted();
          // This structural fixture supplies only the operation handles consumed
          // here, not a claim of descriptor or Surface admission.
          return snapshot as unknown as TargetedContributionSnapshot<TContribution>;
        },
      });
    },
  });
}

export function channelsTargetedContributionServices(
  target: PluginTestkit,
): Readonly<{ targetedContributions: TargetedContributionsService }> {
  return Object.freeze({
    targetedContributions: channelsOperationOnlyTargetedContributionsFixture(target),
  });
}
