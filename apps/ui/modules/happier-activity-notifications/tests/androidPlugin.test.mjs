import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { configureManifest, configureApplication } = require('../withActivityNotificationsAndroid.js');
const moduleRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('Android native alert enrichment consumes the existing crypto worker instead of copying crypto', () => {
  const gradle = readFileSync(join(moduleRoot, 'android', 'build.gradle'), 'utf8');
  assert.match(gradle, /implementation project\(':happier-crypto-worker'\)/);
  const cryptoFacade = readFileSync(join(
    dirname(moduleRoot),
    'happier-crypto-worker', 'android', 'src', 'main', 'java', 'dev', 'happier', 'cryptoworker',
    'HappierCryptoWorkerSessionCrypto.kt',
  ), 'utf8');
  assert.match(cryptoFacade, /public object HappierCryptoWorkerSessionCrypto/);
  assert.match(cryptoFacade, /HappierCryptoWorker\.decryptDataKeyEnvelopeV1Batch/);
  assert.match(cryptoFacade, /HappierCryptoWorker\.decryptSecretboxJsonBatch/);
});

test('native Activity FCM service replaces the Expo entry point in its isolated process', () => {
  const manifest = { manifest: { application: [{ service: [{ $: { 'android:name': 'unrelated.Service' } }] }] } };
  configureManifest(manifest, 'scope_test');
  const application = manifest.manifest.application[0];
  const service = application.service.find((row) => row.$['android:name'] === 'dev.happier.activitynotifications.ActivityFirebaseMessagingService');
  assert.ok(service);
  assert.equal(service.$['android:process'], ':happier_activity_notifications');
  assert.equal(service.$['android:exported'], 'false');
  assert.deepEqual(service['intent-filter'][0].action, [{ $: { 'android:name': 'com.google.firebase.MESSAGING_EVENT' } }]);
  assert.equal(application.service.find((row) => row.$['android:name'] === 'expo.modules.notifications.service.ExpoFirebaseMessagingService').$['tools:node'], 'remove');
  assert.ok(application.service.some((row) => row.$['android:name'] === 'unrelated.Service'));
  const once = structuredClone(manifest);
  configureManifest(manifest, 'scope_test');
  assert.deepEqual(manifest, once);
});

test('Firebase token refresh keeps reaching the app process owner', () => {
  const manifest = { manifest: { application: [{ service: [] }] } };
  configureManifest(manifest, 'scope_test');
  const receiver = manifest.manifest.application[0].receiver
    .find((row) => row.$['android:name'] === 'dev.happier.activitynotifications.ActivityNotificationTokenBridge');
  assert.ok(receiver, 'token refresh would be lost in the isolated messaging process');
  assert.equal(receiver.$['android:exported'], 'false');
  // The receiver belongs to the app process; declaring it in the notification
  // process would forward the token straight back to the process that cannot
  // reach the incumbent listeners.
  assert.equal(receiver.$['android:process'], undefined);
});

test('Application skips React initialization only in the native notification process', () => {
  const source = `package dev.happier.app
class MainApplication : Application(), ReactApplication {
  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }
}`;
  const updated = configureApplication(source, 'kt');
  const guard = 'if (dev.happier.activitynotifications.ActivityNotificationProcess.isCurrent(this)) return';
  assert.ok(updated.includes(guard));
  assert.ok(updated.indexOf(guard) > updated.indexOf('super.onCreate()'));
  assert.ok(updated.indexOf(guard) < updated.indexOf('loadReactNative(this)'));
  assert.equal(configureApplication(updated, 'kt'), updated);
});

test('unrecognized Application initialization fails the build instead of silently starting React', () => {
  assert.throws(() => configureApplication('class MainApplication {}', 'kt'));
});

test('terminated notification messages reach the strict Activity data-body consumer before Firebase auto-display', () => {
  const service = readFileSync(join(
    moduleRoot,
    'android/src/main/java/dev/happier/activitynotifications/ActivityFirebaseMessagingService.kt',
  ), 'utf8');
  assert.match(service, /override fun handleIntent\(intent: Intent\)/);
  assert.match(service, /ActivityRemoteAlertIntent\.prepareForNativePresentation/);
  assert.doesNotMatch(
    service.slice(service.indexOf('override fun handleIntent'), service.indexOf('override fun onMessageReceived')),
    /isMainProcessRunning/,
    'process liveness cannot stand in for foreground state before Firebase auto-display',
  );
  // The transformed intent still flows through FirebaseMessagingService so its
  // delivery acknowledgement and duplicate-message owner remain intact.
  assert.match(service, /super\.handleIntent\(activityIntent\)/);
  const received = service.slice(service.indexOf('override fun onMessageReceived'));
  assert.match(received, /ActivityRemoteAlert\.parse/);
  assert.match(received, /ActivityNotificationMainProcessHandoff\.offer/);
  assert.doesNotMatch(received, /isMainProcessRunning/, 'process liveness must not bypass native exact-Home enrichment');

  const handoff = readFileSync(join(
    moduleRoot,
    'android/src/main/java/dev/happier/activitynotifications/ActivityNotificationMainProcessHandoff.kt',
  ), 'utf8');
  assert.match(handoff, /sendOrderedBroadcast/,
    'the isolated consumer must offer the alert to the already-loaded app-process presentation owner');
  assert.match(handoff, /RECEIVER_NOT_EXPORTED/,
    'the process handoff must remain inside this app');
  const appProcessReceiver = handoff.slice(handoff.indexOf('override fun onReceive'));
  assert.match(appProcessReceiver, /FirebaseMessagingDelegate/,
    'an already-loaded app process must re-enter Expo so its foreground JS handler remains authoritative');
  assert.match(handoff, /ActivityNotificationPresenter\.present/,
    'the isolated closed-app leg must retain the native presentation fallback');
  assert.match(handoff, /RESULT_PRESENTED/,
    'the isolated fallback needs an explicit accepted result rather than a process-liveness guess');

  const module = readFileSync(join(
    moduleRoot,
    'android/src/main/java/dev/happier/activitynotifications/HappierActivityNotificationsModule.kt',
  ), 'utf8');
  assert.match(module, /OnCreate[\s\S]*ActivityNotificationMainProcessHandoff(?:::|\.)register/);
  assert.match(module, /OnDestroy[\s\S]*ActivityNotificationMainProcessHandoff\.unregister/);

  const adapter = readFileSync(join(
    moduleRoot,
    'android/src/main/java/dev/happier/activitynotifications/ActivityRemoteAlertIntent.kt',
  ), 'utf8');
  assert.match(adapter, /gcm\.n\./);
  assert.match(adapter, /gcm\.notification\./);
  assert.match(adapter, /remove\(key\)/);
  assert.match(adapter, /notification\.body\?\.let \{ adaptedExtras\.putString\("message", it\) \}/);
  assert.match(adapter, /putString\("tag", replacementTag\)/);
});
