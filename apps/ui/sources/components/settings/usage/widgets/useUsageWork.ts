import * as React from 'react';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { useSessionListRowsByServerId } from '@/sync/store/hooks';
import { useAllMachines } from '@/sync/domains/state/storage';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { formatUsageCalendarDate } from '@/sync/domains/usage/usageCalendarPresentation';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import {
  summarizeUsageWork,
  type UsageWorkSummary,
  type UsageWorkMoneyBasis,
} from './usageWorkPresentation';
import { useUsageAnalyticsView, useUsageProjectLabels } from './usageBodyKit';
import { readUsageWidgetPageScope, readUsageWidgetQueryOverrides } from '../usageWidgetPageContext';
import { buildUsageRouteParams } from '../usageRouteParams';
import { usageCostKindPhrase } from '../usageCostPresentation';

function countLabels(labels: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

const summaries = new WeakMap<object, Map<string, UsageWorkSummary>>();

/** The Work bodies' shared reading of one slice: U7's allocation grouped once, labels and drill. */
export function useUsageWork(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
  serverId: string,
) {
  const work = slice.work;
  const view = useUsageAnalyticsView(slice, query);
  const protectedProjectLabels = useUsageProjectLabels(serverId);
  const projectLabels = React.useMemo(() => new Map([
    ...(view?.breakdowns.projects ?? []).flatMap(row => row.label ? [[row.key, row.label] as const] : []),
    ...protectedProjectLabels,
  ].flatMap(([key, label]) => {
    const display = label.trim();
    // Protected rows can retain an opaque identity as their label too.
    // Apply one display policy to every source before classifying named work.
    return display && display !== key && !/^[a-f\d]{32,}$/i.test(display) ? [[key, display] as const] : [];
  })), [view?.breakdowns.projects, protectedProjectLabels]);
  const namedProjectKeys = React.useMemo(() => new Set(projectLabels.keys()), [projectLabels]);
  const namesKey = JSON.stringify([...namedProjectKeys].sort());
  const summary = React.useMemo(() => {
    if (!work) return null;
    const key = `${query.metric}\u0000${query.costBasis}\u0000${namesKey}`;
    let byKey = summaries.get(work);
    if (!byKey) {
      byKey = new Map();
      summaries.set(work, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const built = summarizeUsageWork(work, {
      metric: query.metric,
      costBasis: query.costBasis,
    }, namedProjectKeys);
    byKey.set(key, built);
    return built;
  }, [work, query.metric, query.costBasis, namesKey, namedProjectKeys]);
  const format = React.useCallback(
    (value: number | null, moneyBasis: UsageWorkMoneyBasis | null = summary?.moneyBasis ?? null) =>
      value === null ? t('usage.board.recap.money_unpriced') : query.metric === 'cost'
        ? moneyBasis ? `${formatUsageCost(value, moneyBasis.currency)} ${usageCostKindPhrase(moneyBasis.kind)}`
          : t('usage.board.recap.money_unpriced')
        : formatTokenCount(value),
    [summary?.moneyBasis, query.metric],
  );
  const cell = React.useCallback((value: number | null, moneyBasis: UsageWorkMoneyBasis | null) =>
    query.metric !== 'cost' || moneyBasis !== null && summary?.moneyBasis?.kind === moneyBasis.kind
      && summary.moneyBasis.currency === moneyBasis.currency ? value ?? format(null) : format(value, moneyBasis),
    [format, query.metric, summary?.moneyBasis]);
  const basisLabel = React.useCallback((moneyBasis: UsageWorkMoneyBasis | null) => moneyBasis
    ? `${usageCostKindPhrase(moneyBasis.kind)} · ${moneyBasis.currency}` : undefined, []);
  const machines = useAllMachines();
  const machineNames = React.useMemo(() => resolveMachineDisplayNames([...machines,
    ...(summary?.projects ?? []).flatMap(row => row.machineIds).concat((summary?.sessions ?? []).flatMap(row => row.machineIds))
      .filter(id => !machines.some(machine => machine.id === id)).map(id => ({ id, absence: 'unlisted' as const }))]), [machines, summary]);
  const machineWords = React.useCallback((ids: readonly string[]) => ids.map(id => machineNames.get(id) ?? id).join(', '), [machineNames]);
  // Two rows never read alike: a Project name several share keeps its name whole; where it ran is a separate fact the
  // row carries on its own line, so a narrow screen never truncates the part that tells the rows apart.
  const projectName = React.useCallback((projectKey: string | null) => projectKey === null
    ? t('usage.board.work.unknownProject') : projectLabels.get(projectKey) ?? t('usage.board.work.unknownProject'), [projectLabels]);
  const projectPlaces = React.useMemo(() => {
    const counts = countLabels((summary?.projects ?? []).map(row => projectName(row.projectKey)));
    return new Map((summary?.projects ?? []).map(row => [row.projectKey, counts.get(projectName(row.projectKey))! > 1
      ? machineWords(row.machineIds) : ''] as const));
  }, [summary, projectName, machineWords]);
  const projectPlace = React.useCallback((projectKey: string | null) => projectPlaces.get(projectKey) ?? '', [projectPlaces]);
  const sessionHomes = React.useMemo(() => [serverId], [serverId]);
  const renderablesByHome = useSessionListRowsByServerId(sessionHomes);
  const renderables = renderablesByHome[serverId];
  const displaySessionLabels = React.useMemo(() => {
    const base = (sessionId: string) => {
      const renderable = renderables?.[sessionId];
      return renderable ? getSessionName(renderable, serverId) : t('session.untitled');
    };
    const rows = summary?.sessions ?? [];
    const counts = countLabels(rows.map(row => base(row.sessionId)));
    return new Map(rows.map(row => {
      const label = base(row.sessionId);
      if (counts.get(label)! < 2) return [row.sessionId, label] as const;
      const when = row.lastObservedAtMs > 0 ? formatUsageCalendarDate(row.lastObservedAtMs, query.timeZoneOffsetMinutes ?? 0,
        { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      return [row.sessionId, [label, when, machineWords(row.machineIds)].filter(Boolean).join(' · ')] as const;
    }));
  }, [summary, renderables, serverId, machineWords, query.timeZoneOffsetMinutes]);
  const sessionLabel = React.useCallback(
    (sessionId: string) => displaySessionLabels.get(sessionId)
      ?? (renderables?.[sessionId] ? getSessionName(renderables[sessionId]!, serverId) : t('session.untitled')),
    [displaySessionLabels, renderables, serverId],
  );
  const router = useRouter();
  const openSession = React.useCallback(
    (sessionId: string) => {
      router.push(
        buildScopedSessionRouteHref({ sessionId, serverId, suffix: '/usage', query: buildUsageRouteParams({
          scope: { ...readUsageWidgetPageScope(query), session: sessionId }, metric: query.metric,
          queryOverrides: readUsageWidgetQueryOverrides(query),
          costMode: query.costBasis === 'estimated' ? 'estimated' : query.costBasis === 'reported' ? 'reported' : 'auto', layoutId: 'work',
        }) }) as Parameters<
          typeof router.push
        >[0],
      );
    },
    [router, serverId, query],
  );
  return { summary, format, cell, basisLabel, projectLabel: projectName, projectPlace, sessionLabel, openSession };
}
