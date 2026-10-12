import type { UsageActionPorts } from '@happier-dev/protocol/actions/executor/usageActions';
import type { UsageQueryBatchResult } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { decodeUsageQueryResource, getUsageQueryResourceStore, readUiUsageModelPrices, type UsageQueryAccountContext } from '@/sync/api/account/usageQueryResource';
import type { LazyActionAccountContext } from './actionAccountContext';
import { HappyError } from '@/utils/errors/errors';

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
    prices: { get: context => prices(false, context), refresh: context => prices(true, context) },
    query: async (input, context) => {
      context.signal?.throwIfAborted();
      account.assertCurrent();
      let release: (() => void) | undefined;
      let abort: (() => void) | undefined;
      try {
        // A one-shot Action returns its current truthful snapshot; it does not
        // harvest every optional source. This exact Resource also belongs to
        // mounted consumers, whose subscriptions own subsequent progression.
        const entry = getUsageQueryResourceStore(account).getEntry({ hostRead: 'usage.query', input });
        const result = await new Promise<UsageQueryBatchResult>((resolve, reject) => {
          const inspect = () => {
            try {
              account.assertCurrent();
              context.signal?.throwIfAborted();
              const snapshot = entry.getSnapshot();
              if (snapshot.error) throw new HappyError(snapshot.error.message, false, { code: snapshot.error.code });
              if (!snapshot.value || snapshot.freshness !== 'fresh') return;
              const batch = decodeUsageQueryResource(snapshot.value);
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
  };
}
