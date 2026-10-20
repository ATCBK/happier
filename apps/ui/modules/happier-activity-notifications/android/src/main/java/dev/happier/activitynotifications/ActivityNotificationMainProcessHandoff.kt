package dev.happier.activitynotifications

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.HandlerThread
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.RemoteMessageSerializer
import expo.modules.notifications.service.delegates.FirebaseMessagingDelegate
import java.util.concurrent.Executors

/**
 * Hands one recognized Home message to the already-loaded app process.
 *
 * The isolated FCM process cannot observe the app process's Expo foreground
 * handler, visible Session, in-process local-alert coalescer, or its
 * `remote-notification` task registry and React host — all of those are
 * per-process. An ordered, package-private broadcast lets the dynamically
 * registered app-process owner accept the message when that owner is actually
 * loaded. Process liveness is deliberately not used as a proxy for handler
 * availability.
 *
 * Recognized Activity and visible Machine alerts are presented (by the app process when it accepts
 * the handoff, otherwise by the isolated fallback), and the Home's content-free
 * `session_changed` wake only runs the app process's registered wake task. A
 * wake has nothing to present, so it carries no fallback.
 */
object ActivityNotificationMainProcessHandoff {
  private const val ACTION_SUFFIX = ".happier.activitynotifications.PRESENT"
  private const val EXTRA_BODY = "body"
  private const val EXTRA_TITLE = "title"
  private const val EXTRA_MESSAGE = "message"
  private const val EXTRA_SOUND = "sound"
  private const val EXTRA_CHANNEL_ID = "channelId"
  private const val EXTRA_TAG = "tag"
  private const val RESULT_PRESENTED = Activity.RESULT_FIRST_USER + 1

  private val executor = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "happier-activity-notification-handoff").apply { isDaemon = true }
  }
  private val fallbackThread = HandlerThread("happier-activity-notification-fallback").apply { start() }
  private val fallbackHandler = Handler(fallbackThread.looper)
  private var registeredContext: Context? = null
  private var registeredReceiver: BroadcastReceiver? = null

  @JvmStatic
  @Synchronized
  fun register(context: Context) {
    if (ActivityNotificationProcess.isCurrent(context) || registeredReceiver != null) return
    val applicationContext = context.applicationContext
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receiveContext: Context, intent: Intent) {
        if (intent.action != action(receiveContext)) return
        val pending = goAsync()
        executor.execute {
          try {
            val message = remoteMessage(intent) ?: return@execute
            val applicationContext = receiveContext.applicationContext
            val alert = ActivityRemoteAlert.parse(message)
            if (alert != null) {
              val enrichedMessage = ActivityNotificationPresenter.enrichedMessage(applicationContext, message, alert)
              FirebaseMessagingDelegate(applicationContext).onMessageReceived(enrichedMessage)
              pending.setResultCode(RESULT_PRESENTED)
              return@execute
            }
            val machineAlert = MachineRemoteAlert.parse(message)
            if (machineAlert != null) {
              val enrichedMessage = ActivityNotificationPresenter.enrichedMessage(applicationContext, message, machineAlert)
              FirebaseMessagingDelegate(applicationContext).onMessageReceived(enrichedMessage)
              pending.setResultCode(RESULT_PRESENTED)
              return@execute
            }
            if (SessionChangedWake.parse(message) != null) {
              // Only the task arm of the incumbent delegate: a content-free wake
              // is never presented, and the registered app-process consumer is
              // the single owner of what the wake makes visible.
              FirebaseMessagingDelegate.runTaskManagerTasks(
                applicationContext,
                RemoteMessageSerializer.toBundle(message),
              )
            }
          } catch (_: Throwable) {
            // Keep the ordered result unclaimed so the isolated fallback owns it.
          } finally {
            pending.finish()
          }
        }
      }
    }
    val filter = IntentFilter(action(applicationContext))
    ContextCompat.registerReceiver(
      applicationContext,
      receiver,
      filter,
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    registeredContext = applicationContext
    registeredReceiver = receiver
  }

  @JvmStatic
  @Synchronized
  fun unregister() {
    val context = registeredContext
    val receiver = registeredReceiver
    registeredContext = null
    registeredReceiver = null
    if (context != null && receiver != null) {
      try {
        context.unregisterReceiver(receiver)
      } catch (_: IllegalArgumentException) {
        // The app process may already be tearing down the receiver registry.
      }
    }
  }

  @JvmStatic
  fun offer(context: Context, remoteMessage: RemoteMessage, alert: ActivityRemoteAlert) {
    offer(context, remoteMessage, alert.replacementTag) {
      ActivityNotificationPresenter.present(context.applicationContext, remoteMessage, alert)
    }
  }

  @JvmStatic
  fun offer(context: Context, remoteMessage: RemoteMessage, alert: MachineRemoteAlert) {
    offer(context, remoteMessage, alert.replacementTag) {
      ActivityNotificationPresenter.present(context.applicationContext, remoteMessage, alert)
    }
  }

  private fun offer(context: Context, remoteMessage: RemoteMessage, replacementTag: String, presentFallback: () -> Unit) {
    val handoff = Intent(action(context)).setPackage(context.packageName)
    copy(remoteMessage.data, EXTRA_BODY, handoff)
    copy(remoteMessage.data, EXTRA_TITLE, handoff)
    copy(remoteMessage.data, EXTRA_MESSAGE, handoff)
    copy(remoteMessage.data, EXTRA_SOUND, handoff)
    copy(remoteMessage.data, EXTRA_CHANNEL_ID, handoff)
    handoff.putExtra(EXTRA_TAG, replacementTag)

    val fallback = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context, intent: Intent) {
        if (resultCode != RESULT_PRESENTED) {
          presentFallback()
        }
      }
    }
    context.sendOrderedBroadcast(
      handoff,
      null,
      fallback,
      fallbackHandler,
      Activity.RESULT_CANCELED,
      null,
      null,
    )
  }

  /**
   * Offers the Home's content-free wake to the app process.
   *
   * There is no fallback arm: the wake renders nothing by itself, so when the
   * app process is not loaded it is simply dropped, exactly like an undelivered
   * background notification. Waking a terminated app would require moving the
   * whole Firebase entry point out of the isolated process.
   */
  @JvmStatic
  fun offerWake(context: Context, remoteMessage: RemoteMessage) {
    val handoff = Intent(action(context)).setPackage(context.packageName)
    copy(remoteMessage.data, EXTRA_BODY, handoff)
    context.sendOrderedBroadcast(handoff, null)
  }

  private fun action(context: Context): String = context.packageName + ACTION_SUFFIX

  private fun copy(data: Map<String, String>, key: String, intent: Intent) {
    data[key]?.let { intent.putExtra(key, it) }
  }

  private fun remoteMessage(intent: Intent): RemoteMessage? {
    val body = intent.getStringExtra(EXTRA_BODY) ?: return null
    val packageName = intent.`package` ?: return null
    val data = mutableMapOf(EXTRA_BODY to body)
    // A wake carries no replacement identity or presentation fields; an alert
    // always carries the tag its presenter replaces on.
    for (key in listOf(EXTRA_TAG, EXTRA_TITLE, EXTRA_MESSAGE, EXTRA_SOUND, EXTRA_CHANNEL_ID)) {
      intent.getStringExtra(key)?.let { data[key] = it }
    }
    return RemoteMessage.Builder(packageName)
      .apply { data[EXTRA_TAG]?.let { setMessageId(it) } }
      .setData(data)
      .build()
  }
}
