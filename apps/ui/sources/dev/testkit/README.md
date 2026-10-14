# UI Testkit

Canonical UI-local testing surface for `apps/ui`.

## Buckets

- `mocks/`: canonical module mock factories for repeated UI boundaries. Inside a `vi.mock` factory,
  import the factory's own module (for example `@/dev/testkit/mocks/reactNative`, `mocks/unistyles` or
  `mocks/popover`), not `@/dev/testkit`. The index's import graph loads the module being mocked: for
  `react-native` the factory waits on itself and collection never finishes, and for others the mock can
  silently not apply.
- `fixtures/`: typed app-state and feature fixture builders
- `render/`: shared `react-test-renderer` render surfaces
- `hooks/`: hook render, deferred, and effect-flush helpers
- `harness/`: repeated screen and feature harnesses
- `cleanup/`: shared cleanup registration used by render and hook helpers

## Migration Rules

- Prefer importing from `@/dev/testkit` in new tests.
- Import a bucket module directly only when its helper is intentionally not part of the root testkit surface.
- Prefer `renderSettingsView` or `renderScreen` over file-local `findByTestId` helpers.
- Prefer `renderHook` and `flushHookEffects` over local `renderer.create` hook harnesses and bespoke promise loops.
- Prefer canonical mock factories for `@/text`, `@/modal`, `expo-router`, `react-native`, `react-native-unistyles`, and `@/sync/domains/state/storage`.

## Transport boundary import order

The root `@/dev/testkit` entry stays free of runtime singletons and may be statically imported.
Home and Provider harnesses are available from their owning `harness/homeGovernanceHarness` and
`harness/providerSettingsHarness` modules. Install their HTTP/RPC boundaries before importing screens,
hooks, or other runtime consumers, including layout components whose dependency graph reaches Sync.
The Machine Administration selection fixture/mock also imports a runtime owner; use its own
`mocks/machineAdministrationTargetSelection` module and load it after Home boundary installation.
Registry UI mocks load the bundled plugin catalog and are available only from
`mocks/registryUiBehavior`; unrelated root-testkit consumers do not load that catalog.
Storage mocks and the ChatList harness load real Settings and the Agent/Voice catalogs;
import them from `mocks/storage` and `harness/chatListHarness` only in suites that need them.
Root-exported fixtures use the Protocol's narrow public subpaths rather than its complete barrel.
Load those consumers with `await import(...)` after installation:

```ts
import { renderScreen } from '@/dev/testkit';
import {
    createProviderSettingsHarness,
    createProviderSettingsAccountHarness,
    installProviderSettingsRpcBoundary,
} from '@/dev/testkit/harness/providerSettingsHarness';

const rpc = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(rpc);
const account = createProviderSettingsAccountHarness(); // Installs Home HTTP and Socket boundaries.
const { ProviderConnectionsSettingsScreen } = await import(
    '@/components/settings/providers/ProviderConnectionsSettingsScreen'
);
```

The installers reject already imported real transports with a `[testkit]` error naming the installer
and module. `vi.doMock` affects later imports; it cannot replace references already held by a screen.
Move the premature import rather than using `vi.resetModules` to reload part of the runtime graph.
Reinstalling a boundary that was correctly installed remains supported; its delegates read the current
harness at call time, even after Vitest evicts a cached mock. For a suite that must statically import a Socket consumer, use the hoisted
`vi.mock('socket.io-client', ...)` factory documented in `serverAccountConnectionHarness.ts` before
configuring it with `installDisconnectedServerSocketBoundary`.
