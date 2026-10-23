import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'acme.packed-background-service';

export function activate(api) {
    let heldDemand;
    api.events.register('observe-ready', async (payload, context) => {
        await context.services.storage.ephemeral.set('latest-ready', payload);
    });
    api.events.register('observe-cancel', async (_payload, context) => {
        await context.services.storage.ephemeral.set('cancellation-requested', true);
    });
    api.actions.register('start-held', async (_input, context) => {
        let resolveReady;
        const ready = new Promise(resolve => { resolveReady = resolve; });
        const subscription = context.services.events.plugin.subscribe(
            { pluginId: PLUGIN_ID, localId: 'ready' }, ({ payload }) => { if (payload.kind === 'started') resolveReady(payload); },
        );
        const demand = context.services.backgroundServices.demand('custody', 'native-custody-proof');
        heldDemand = demand;
        try {
            return await Promise.race([ready, demand.settlement.then(() => { throw new Error('custody_runner_settled_before_readiness'); })]);
        } finally { subscription.dispose(); }
    });
    api.actions.register('cancel-one', async (_input, context) => {
        let resolveCancelled;
        const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
        const subscription = context.services.events.plugin.subscribe(
            { pluginId: PLUGIN_ID, localId: 'ready' }, ({ payload }) => { if (payload.kind === 'cancelled') resolveCancelled(payload); },
        );
        try {
            await context.services.events.plugin.emit('cancel-requested', {});
            return await cancelled;
        } finally { subscription.dispose(); }
    });
    api.actions.register('wait-held', async (_input, context) => {
        if (!heldDemand) throw new Error('custody_runner_has_not_started');
        await context.services.storage.daemon.set('wait-held-demanded', true);
        await heldDemand.settlement;
        return { settled: true };
    });
    api.actions.register('probe-state', async (_input, context) => ({
        waitHeldDemanded: await context.services.storage.daemon.get('wait-held-demanded'),
    }));
    api.backgroundServices.register('custody', async context => {
        const tool = await context.services.exec.systemTools.resolve({
            toolId: 'fixture-tail', purpose: 'Run test-owned native custody probes',
        });
        const spawnHeld = async (label, signal) => {
            return await context.services.exec.spawn({ executable: tool.executable,
                args: ['-f', fileURLToPath(new URL(`./${label}.txt`, import.meta.url))],
            }, { signal });
        };
        const cancellation = new AbortController();
        const first = await spawnHeld('first', cancellation.signal);
        const second = await spawnHeld('second', context.signal);
        const cancelSubscription = context.services.events.plugin.subscribe(
            { pluginId: PLUGIN_ID, localId: 'cancel-requested' }, () => cancellation.abort(),
        );
        await context.services.events.plugin.emit('ready', {
            kind: 'started', workerPid: process.pid,
        }, { signal: context.signal });
        try {
            const result = await Promise.race([first.wait(), second.wait().then(result => {
                throw new Error('held_sibling_ended_unexpectedly: ' + JSON.stringify(result.termination));
            })]);
            if (!cancellation.signal.aborted) {
                throw new Error('cancelled_probe_ended_before_cancellation: ' + JSON.stringify(result.termination));
            }
            await context.services.events.plugin.emit('ready', { kind: 'cancelled' }, { signal: context.signal });
            await new Promise(resolve => {
                if (context.signal.aborted) resolve();
                else context.signal.addEventListener('abort', resolve, { once: true });
            });
        } finally { cancelSubscription.dispose(); }
    });
}
