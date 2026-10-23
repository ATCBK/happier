const PLUGIN_ID = 'acme.packed-background-service';

function isProcessAbsent(pid) {
    if (typeof pid !== 'number') return true;
    try {
        process.kill(pid, 0);
        return false;
    } catch (error) {
        if (error?.code === 'ESRCH') return true;
        throw error;
    }
}

export function activate(api) {
    let activeHeldDemand;
    api.events.register('observe-ready', async (payload, context) => {
        await context.services.storage.ephemeral.set('latest-ready', payload);
    });
    api.actions.register('host-echo', async () => ({ daemonPid: process.pid }));
    api.actions.register('probe-state', async (_input, context) => ({
        waitHeldDemanded: await context.services.storage.daemon.get('wait-held-demanded'),
    }));
    api.actions.register('wait-held', async (_input, context) => {
        const demand = activeHeldDemand;
        if (!demand) throw new Error('held_demand_not_started');
        const cancel = () => demand.cancel();
        context.signal.addEventListener('abort', cancel, { once: true });
        try {
            await context.services.storage.daemon.set('wait-held-demanded', true);
            await demand.settlement;
            return { settled: true };
        } finally {
            context.signal.removeEventListener('abort', cancel);
        }
    });
    api.actions.register('verify', async (input, context) => {
        const storage = context.services.storage.daemon;
        const previousChildPid = (await storage.get('last-run'))?.childPid ?? null;
        const previousChildProcessAbsent = isProcessAbsent(previousChildPid);
        if (!previousChildProcessAbsent) throw new Error('background_process_survived_settlement');
        const initialCount = await storage.get('run-count') ?? 0;
        const verifiedCount = await storage.get('verified-run-count') ?? 0;
        if (initialCount !== verifiedCount) throw new Error('background_service_started_without_demand');
        const runs = input.runs ?? 1;
        const childPids = [];
        let services;
        for (let index = 0; index < runs; index += 1) {
            const demand = context.services.backgroundServices.demand('index', 'packed-proof');
            const cancel = () => demand.cancel();
            context.signal.addEventListener('abort', cancel, { once: true });
            try {
                await demand.settlement;
            } finally {
                context.signal.removeEventListener('abort', cancel);
            }
            const observation = await storage.get('last-run');
            if (observation.services.actions.status === 'available' && observation.daemonPid !== process.pid) {
                throw new Error('action_proxy_missed_daemon');
            }
            if (observation.childPid === process.pid) throw new Error('runner_used_daemon_process');
            if (!isProcessAbsent(observation.childPid)) throw new Error('settled_child_still_running');
            childPids.push(observation.childPid);
            services = observation.services;
        }
        if (new Set(childPids).size !== runs) throw new Error('demand_reused_settled_child');
        const runCount = await storage.get('run-count');
        if (runCount !== initialCount + runs) throw new Error('background_service_started_without_demand');
        await storage.set('verified-run-count', runCount);
        return { daemonPid: process.pid, childPids, previousChildPid,
            previousChildProcessAbsent, completedRuns: runCount - initialCount, services };
    });
    api.actions.register('start-held', async (_input, context) => {
        const previousHeldPid = await context.services.storage.daemon.get('held-pid');
        const previousHeldProcessAbsent = isProcessAbsent(previousHeldPid);
        if (!previousHeldProcessAbsent) throw new Error('background_process_survived_retirement');
        let resolveHeldReady;
        const heldReady = new Promise((resolve) => { resolveHeldReady = resolve; });
        const subscription = context.services.events.plugin.subscribe(
            { pluginId: PLUGIN_ID, localId: 'ready' },
            ({ payload }) => {
                if (payload.kind === 'held') resolveHeldReady(payload.pid);
            },
        );
        const held = context.services.backgroundServices.demand('retirement-probe', 'uninstall-proof');
        activeHeldDemand = held;
        const cancel = () => held.cancel();
        context.signal.addEventListener('abort', cancel, { once: true });
        try {
            const heldPid = await Promise.race([
                heldReady,
                held.settlement.then(() => { throw new Error('held_runner_settled_before_ready'); }),
            ]);
            return { daemonPid: process.pid, heldPid, previousHeldPid, previousHeldProcessAbsent };
        } finally {
            context.signal.removeEventListener('abort', cancel);
            subscription.dispose();
        }
    });
    api.backgroundServices.register('index', async (context) => {
        context.signal.throwIfAborted();
        const settings = context.services.settings.forScope({ kind: 'daemon' });
        const descriptors = settings.describe();
        const snapshot = await settings.snapshot({ signal: context.signal });
        if (!Array.isArray(descriptors) || snapshot.scope.kind !== 'daemon') {
            throw new Error('settings_proxy_lost_scope');
        }
        if (context.services.availability('secrets').status !== 'unavailable') {
            throw new Error('unsupported_process_service_advertised');
        }
        context.services.logger.info('Packed process runner started');
        const actions = context.services.availability('actions');
        let daemonPid = null;
        if (actions.status === 'available') {
            const echo = await context.services.actions.execute(
                { pluginId: PLUGIN_ID, localId: 'host-echo' }, {}, { signal: context.signal },
            );
            daemonPid = echo.daemonPid;
        } else {
            // The isolated author host has no Account credentials. Preserve
            // that host's typed refusal instead of fabricating Action authority.
            let refusalCode;
            try {
                await context.services.actions.execute(
                    { pluginId: PLUGIN_ID, localId: 'host-echo' }, {}, { signal: context.signal },
                );
            } catch (error) {
                refusalCode = error?.code;
            }
            if (refusalCode !== actions.code) throw new Error('unavailable_action_service_did_not_refuse');
        }
        await context.services.storage.daemon.transaction(async (transaction) => {
            const count = await transaction.get('run-count') ?? 0;
            await transaction.set('run-count', count + 1);
            await transaction.set('last-run', {
                childPid: process.pid, parentPid: process.ppid, daemonPid,
                services: {
                    storage: context.services.availability('storage'),
                    settings: context.services.availability('settings'),
                    events: context.services.availability('events'),
                    actions,
                },
            });
        }, { signal: context.signal });
    });
    api.backgroundServices.register('retirement-probe', async (context) => {
        await context.services.storage.daemon.set('held-pid', process.pid, { signal: context.signal });
        await context.services.events.plugin.emit('ready', { kind: 'held', pid: process.pid }, { signal: context.signal });
        await new Promise((resolve) => {
            if (context.signal.aborted) resolve();
            else context.signal.addEventListener('abort', resolve, { once: true });
        });
    });
}
