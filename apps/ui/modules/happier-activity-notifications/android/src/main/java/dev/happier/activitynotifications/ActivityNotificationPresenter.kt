package dev.happier.activitynotifications

import android.content.Context
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.notifications.model.Notification
import expo.modules.notifications.notifications.model.NotificationRequest
import expo.modules.notifications.notifications.model.RemoteNotificationContent
import expo.modules.notifications.notifications.model.triggers.FirebaseNotificationTrigger
import expo.modules.notifications.service.delegates.ExpoPresentationDelegate
import java.util.Date

/**
 * Presents an Activity remote alert from whichever process currently owns it.
 *
 * Presentation, channel resolution, sound and the tap response intent stay with
 * the app's existing notification owner ([ExpoPresentationDelegate]); this owner
 * only supplies the canonical replacement identity. The isolated fallback keeps
 * the alert out of the app-startup path; an already-loaded app process instead
 * reaches its incumbent foreground handler. The submitted content is presented as received: the Home's
 * generic fallback already passed the recipient's mute, quiet-hours and preview
 * decision before submission, and nothing here fabricates Session detail.
 */
object ActivityNotificationPresenter {
  @JvmStatic
  fun enrichedMessage(context: Context, remoteMessage: RemoteMessage, alert: MachineRemoteAlert): RemoteMessage {
    val enrichment = ActivityNotificationEnricher.enrichment(context, alert) ?: return remoteMessage
    return RemoteMessage.Builder(remoteMessage.from ?: context.packageName)
      .setMessageId(remoteMessage.messageId ?: alert.replacementTag)
      .setData(remoteMessage.data + (enrichment.title?.let { mapOf("title" to it) } ?: emptyMap()))
      .build()
  }

  @JvmStatic
  fun present(context: Context, remoteMessage: RemoteMessage, alert: MachineRemoteAlert) {
    val delegate = ExpoPresentationDelegate(context)
    if (alert.phase == "recovered" && remoteMessage.data["message"].isNullOrBlank()) {
      if (ActivityPreparedContext.home(context, alert.serverId, alert.accountId) == null) return
      // Data-only recovery clears the established identity. A requested return
      // has visible Home-approved content and uses the same presenter below.
      val offlineIds = delegate.getAllPresentedNotifications().mapNotNull { notification ->
        val request = notification.notificationRequest
        val notice = request.content.body?.let { MachineRemoteAlert.parse(it) }
        if (notice?.phase == "offline" && notice.serverId == alert.serverId
            && notice.accountId == alert.accountId && notice.machineId == alert.machineId) request.identifier else null
      }
      if (offlineIds.isNotEmpty() && ActivityPreparedContext.home(context, alert.serverId, alert.accountId) != null) {
        delegate.dismissNotifications(offlineIds)
      }
      return
    }
    val presented = enrichedMessage(context, remoteMessage, alert)
    val request = NotificationRequest(alert.replacementTag, RemoteNotificationContent(presented), FirebaseNotificationTrigger(presented))
    delegate.presentNotification(Notification(request, Date(remoteMessage.sentTime)), null)
  }

  @JvmStatic
  fun enrichedMessage(context: Context, remoteMessage: RemoteMessage, alert: ActivityRemoteAlert): RemoteMessage {
    val enrichment = ActivityNotificationEnricher.enrichment(context, alert)
    return if (enrichment == null) remoteMessage else RemoteMessage.Builder(
      remoteMessage.from ?: context.packageName,
    ).setMessageId(remoteMessage.messageId ?: alert.replacementTag)
      .setData(remoteMessage.data
        + (enrichment.title?.let { mapOf("title" to it) } ?: emptyMap())
        + (enrichment.body?.let { mapOf("message" to it) } ?: emptyMap()))
      .build()
  }

  @JvmStatic
  fun present(context: Context, remoteMessage: RemoteMessage, alert: ActivityRemoteAlert) {
    val presentedMessage = enrichedMessage(context, remoteMessage, alert)
    val request = NotificationRequest(
      alert.replacementTag,
      RemoteNotificationContent(presentedMessage),
      FirebaseNotificationTrigger(presentedMessage),
    )
    ExpoPresentationDelegate(context)
      .presentNotification(Notification(request, Date(remoteMessage.sentTime)), null)
  }
}
