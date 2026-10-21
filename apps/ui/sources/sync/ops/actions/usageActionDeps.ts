import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { decodeUsageQueryResource, getUsageQueryResourceStore, readUiQuota, readUiUsageModelPrices, type UsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import type { LazyActionAccountContext } from './actionAccountContext';
import { HappyError } from '@/utils/errors/errors';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';

/** Captured Home/Account reads use the same query adapter as mounted Resources. */
export function createUiUsageActionPorts(account: UsageQueryAccountContext & Pick<LazyActionAccountContext, 'assertCurrent'>,
  renderRecap?: UsageActionPorts['renderRecap']): UsageActionPorts {
  const prices = async (refresh: boolean, context: Parameters<NonNullable<UsageActionPorts['prices']>['get']>[0]) => {
    context.signal?.throwIfAborted();
    account.assertCurrent();
    try {
      const value = await readUiUsageModelPrices(account, refresh, context.signal);
      context.signal?.throwIfAborted();
      account.assertCurrent();
      return value;
    } catch (error) {
      account.assertCurrent();
      context.signal?.throwIfAborted();
      if (error instanceof HappyError && error.code) return { ok: false as const, errorCode: error.code, error: error.code };
      throw error;
    }
  };
  return {
    readPublicProfile: async context => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      const response = await account.request('/v1/account/public-profile/view', { method: 'GET',
        headers: { Authorization: `Bearer ${account.credentials.token}` }, ...(context.signal ? { signal: context.signal } : {}) });
      context.signal?.throwIfAborted();
      account.assertCurrent();
      if ([404, 405, 501].includes(response.status)) return { kind: 'unavailable' };
      if (!response.ok) return { ok: false, errorCode: response.status === 401 || response.status === 403 ? 'denied' : 'public_profile_read_failed',
        error: 'public_profile_read_failed' };
      const raw: unknown = await response.json();
      context.signal?.throwIfAborted();
      account.assertCurrent();
      const result = PublicProfileReadResultV1Schema.safeParse(raw);
      return result.success ? result.data : { ok: false, errorCode: 'public_profile_result_invalid', error: 'public_profile_result_invalid' };
    },
    prices: { get: context => prices(false, context), refresh: context => prices(true, context) },
    readQuota: async (input, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      try {
        // Calendar selections require their exact retained B, not the query's
        // accounting-ready snapshot while independent quota reads progress.
        const value = await readUiQuota(account, input, context.signal);
        context.signal?.throwIfAborted();
        account.assertCurrent();
        return value;
      } catch (error) {
        account.assertCurrent();
        context.signal?.throwIfAborted();
        if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code) {
          return { ok: false, errorCode: error.code, error: error.code };
        }
        throw error;
      }
    },
    query: async (input, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      let release: (() => void) | undefined;
      let abort: (() => void) | undefined;
      try {
        // A one-shot Action returns its current truthful snapshot; it does not
        // harvest every optional source. This exact Resource also belongs to
        // mounted consumers, whose subscriptions own subsequent progression.
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
        const result = await new Promise<UsageQueryBatchResult>((resolve, reject) => {
          const inspect = () => {
            try {
              account.assertCurrent();
              context.signal?.throwIfAborted();
              const snapshot = entry.getSnapshot();
              if (snapshot.error) throw new HappyError(snapshot.error.message, false, { code: snapshot.error.code });
              if (!snapshot.value || snapshot.freshness !== 'fresh') return;
              const batch = decodeUsageQueryResource(snapshot.value);
              // Coach must inspect the requested private evidence, rather than
              // refuse advice from the earlier accounting-only revision.
              if (context.usageQueryReadiness === 'coach_evidence' && batch.results.some(slice =>
                slice.requestedQuery.includeSessionEvidence && slice.sources.some(source =>
                  source.source === 'how_you_work' && ['pending', 'not_loaded'].includes(source.status)))) return;
              if (batch.results.every(slice => slice.sources.some(source => source.source === 'accounting'
                && !['pending', 'not_loaded'].includes(source.status)))) resolve(batch);
            } catch (error) { reject(error); }
          };
          // An initial read also supplies the Resource owner's terminal
          // admission result. The static subscription joins this same read.
          const baseline = entry.getSnapshot().value ? undefined : entry.refresh();
          release = entry.subscribe(inspect, false);
          void baseline?.then(snapshot => {
            if (snapshot.error) reject(new HappyError(snapshot.error.message, false, { code: snapshot.error.code }));
            else inspect();
          }, reject);
          abort = inspect;
          context.signal?.addEventListener('abort', abort, { once: true });
          inspect();
        });
        account.assertCurrent();
        context.signal?.throwIfAborted();
        return result;
      } catch (error) {
        account.assertCurrent();
        context.signal?.throwIfAborted();
        if (error instanceof HappyError && error.code) return { ok: false, errorCode: error.code, error: error.code };
        throw error;
      } finally {
        release?.();
        if (abort) context.signal?.removeEventListener('abort', abort);
      }
    },
    renderRecap: async (compose, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      const retired = new AbortController();
      const removeRetire = account.accountLifetime.onRetire(() => retired.abort());
      const abort = () => retired.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      try {
        const render = renderRecap ?? (await import('@/components/settings/usage/widgets/recap/renderUsageRecapImage')).renderUsageRecapImage;
        account.assertCurrent();
        const result = await render(compose, { ...context, signal: retired.signal });
        context.signal?.throwIfAborted();
        account.assertCurrent();
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
    deliverRecap: async (file, intent, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      const retired = new AbortController();
      const removeRetire = account.accountLifetime.onRetire(() => retired.abort());
      const abort = () => retired.abort();
      context.signal?.addEventListener('abort', abort, { once: true });
      try {
        const { deliverUsageImageFileResult } = await import('@/components/settings/usage/usageAnalyticsExport');
        account.assertCurrent();
        const result = await deliverUsageImageFileResult(file, intent, { signal: retired.signal,
          isCurrent: () => { account.assertCurrent(); return true; } });
        context.signal?.throwIfAborted();
        account.assertCurrent();
        return result;
      } finally {
        removeRetire.dispose();
        context.signal?.removeEventListener('abort', abort);
      }
    },
  };
}
