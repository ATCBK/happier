package dev.happier.activitynotifications

import android.content.Intent
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService

/**
 * The single Firebase messaging entry point for this app.
 *
 * It runs in the isolated `:happier_activity_notifications` process so a closed
 * app can present an Activity remote alert without starting the app runtime. It
 * is not a second sender: exactly one path handles each message.
 *
 * - A recognized Activity remote alert is offered to an already-loaded app
 *   process so its foreground/privacy handler remains authoritative, otherwise
 *   it is presented here through the same presenter after exact-Home admission.
 * - The Home's content-free `session_changed` wake is offered to the app
 *   process only, because the `remote-notification` task-manager registry and
 *   the React host that owns the wake consumer are per-process and this process
 *   deliberately has neither. A wake that arrives while the app process is not
 *   loaded is dropped rather than presented: it carries no content, and waking a
 *   terminated app would mean moving this entry point out of the isolated
 *   process.
 * - Everything else is delegated to the incumbent Expo delegate.
 */
class ActivityFirebaseMessagingService : ExpoFirebaseMessagingService() {
  override fun onCreate() {
    super.onCreate()
    // `FirebaseInitProvider` only runs in the app process, so this process must
    // initialize Firebase itself before handling a message.
    FirebaseApp.initializeApp(applicationContext)
  }

  override fun onNewToken(token: String) {
    ActivityNotificationTokenBridge.forward(applicationContext, token)
  }

  override fun handleIntent(intent: Intent) {
    // Adapt every recognized notification message before Firebase decides
    // whether the app is foregrounded. Process liveness is not foreground
    // state: a backgrounded app process must still reach onMessageReceived and
    // the incumbent Expo handling owner rather than Firebase auto-display.
    val activityIntent = ActivityRemoteAlertIntent.prepareForNativePresentation(intent)
    if (activityIntent != null) {
      super.handleIntent(activityIntent)
      return
    }
    super.handleIntent(intent)
  }

  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    val alert = ActivityRemoteAlert.parse(remoteMessage)
    if (alert != null) {
      ActivityNotificationMainProcessHandoff.offer(applicationContext, remoteMessage, alert)
      return
    }
    val machineAlert = MachineRemoteAlert.parse(remoteMessage)
    if (machineAlert != null) {
      if (machineAlert.phase == "recovered" && remoteMessage.data["message"].isNullOrBlank()) {
        // Content-free recovery only dismisses the offline notice. Visible
        // returns reach the loaded app's foreground policy like offline alerts.
        ActivityNotificationPresenter.present(applicationContext, remoteMessage, machineAlert)
      } else {
        ActivityNotificationMainProcessHandoff.offer(applicationContext, remoteMessage, machineAlert)
      }
      return
    }
    if (SessionChangedWake.parse(remoteMessage) != null) {
      ActivityNotificationMainProcessHandoff.offerWake(applicationContext, remoteMessage)
      return
    }
    super.onMessageReceived(remoteMessage)
  }
}
