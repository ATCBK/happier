package dev.happier.activitynotifications

import android.content.Intent
import android.os.Bundle
import com.google.firebase.messaging.RemoteMessage

/**
 * Adapts an Expo notification+data message before Firebase's background
 * auto-display branch consumes it.
 *
 * Firebase only invokes [ActivityFirebaseMessagingService.onMessageReceived]
 * for a notification message while the app is foregrounded. For a recognized
 * Activity alert, remove only Firebase's presentation keys and copy their
 * already-policy-approved generic content to Expo's data presentation fields.
 * Passing the adapted intent back through
 * `FirebaseMessagingService.handleIntent` preserves Firebase's acknowledgement
 * and duplicate-message owner; it then reaches the strict `data["body"]`
 * consumer as a data message.
 */
object ActivityRemoteAlertIntent {
  private const val CURRENT_NOTIFICATION_PREFIX = "gcm.n."
  private const val LEGACY_NOTIFICATION_PREFIX = "gcm.notification."

  @JvmStatic
  fun prepareForNativePresentation(intent: Intent): Intent? {
    val originalExtras = intent.extras ?: return null
    val remoteMessage = RemoteMessage(Bundle(originalExtras))
    val replacementTag = ActivityRemoteAlert.parse(remoteMessage)?.replacementTag
      ?: MachineRemoteAlert.parse(remoteMessage)?.replacementTag ?: return null
    val notification = remoteMessage.notification ?: return null

    val adaptedExtras = Bundle(originalExtras)
    for (key in adaptedExtras.keySet().toList()) {
      if (key.startsWith(CURRENT_NOTIFICATION_PREFIX) || key.startsWith(LEGACY_NOTIFICATION_PREFIX)) {
        adaptedExtras.remove(key)
      }
    }
    notification.title?.let { adaptedExtras.putString("title", it) }
    notification.body?.let { adaptedExtras.putString("message", it) }
    notification.sound?.let { adaptedExtras.putString("sound", it) }
    notification.channelId?.let { adaptedExtras.putString("channelId", it) }
    // Expo's incumbent delegate consumes this field as its replacement
    // identifier when the main process owns foreground/background handling.
    adaptedExtras.putString("tag", replacementTag)

    return Intent(intent).replaceExtras(adaptedExtras)
  }
}
