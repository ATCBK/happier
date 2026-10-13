import { createRuntime } from './agent-runtime.mjs';

export { createRuntime };

export function activate(api) {
  api.events.register('watch-measured-event', async () => undefined);
  api.agents.register('novel-native-agent', createRuntime, {
    sessionRunnerFactory: { module: './agent-runtime.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
    connectedAccountLaunch: {
      stateSharingDescriptor: {
        providerSupportStatus: 'supported',
        nativeHome: {
          environmentKey: 'HAPPIER_FIXTURE_AGENT_HOME',
          defaultRelativePath: '.happier-runtime-fixture',
          materializedDirectoryName: 'fixture-home',
        },
        config: { supported: true, modes: ['linked', 'copied', 'isolated'], entries: [] },
        state: {
          supported: true, modes: ['isolated', 'shared'], entries: [],
          sharedStatePrivacyRiskAcknowledgementRequired: true,
          symlinkUnavailableDegradePolicy: 'block_continuity',
        },
        authIsolation: { mode: 'materialized_home', secretEntries: [] },
      },
    },
  });
  api.actions.register('prove-coexistence', async (input, context) => {
    let resolveEvent;
    const eventDelivered = new Promise((resolve) => {
      resolveEvent = resolve;
    });
    const eventSubscription = context.services.events.subscribe(
      { pluginId: 'acme.native-runtime-proof', localId: 'measured-event' },
      async () => resolveEvent(),
    );
    await context.services.events.emit('measured-event', {
      source: 'packed-contribution-action',
      phase: input.phase,
    });
    await eventDelivered;
    eventSubscription.dispose();

    const protocol = await context.services.exec.clients.spawn({
      kind: 'jsonStream',
      launch: {
        executable: { kind: 'systemTool', id: 'fixture-node' },
        args: ['-e', "process.stdin.once('data', () => { process.stderr.write('packed-action-stderr'); process.stdout.write(JSON.stringify({ acknowledged: true }) + '\\n'); setTimeout(() => process.exit(0), 10); });"],
      },
      maxFrameBytes: 1024,
    });
    let resolveRecord;
    const recordDelivered = new Promise((resolve) => {
      resolveRecord = resolve;
    });
    const recordSubscription = protocol.client.subscribe((value) => resolveRecord(value));
    await protocol.client.write({ trigger: true });
    const record = await recordDelivered;
    await protocol.wait();
    recordSubscription.dispose();
    await protocol.dispose();

    return Object.freeze({
      family: 'actions',
      mixedActivation: true,
      input,
      measuredProtocol: record,
    });
  });
}
