package dev.happier.activitynotifications

import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/** Separate closed Machine alert V1, owned by protocol/push/machineRemoteAlert.ts. */
data class MachineRemoteAlert(
  val serverId: String,
  val accountId: String,
  val machineId: String,
  val phase: String,
  val previewBehavior: String,
) {
  val replacementTag: String get() = "machine_alert:$serverId:$accountId:$machineId"

  companion object {
    @JvmStatic fun parse(remoteMessage: RemoteMessage): MachineRemoteAlert? {
      val raw = remoteMessage.data["body"] ?: return null
      val payload = try { JSONObject(raw) } catch (_: Throwable) { return null }
      return parse(payload)
    }

    @JvmStatic fun parse(payload: JSONObject): MachineRemoteAlert? {
      if (payload.keys().asSequence().toSet() != setOf("type", "v", "serverId", "accountId", "machineId", "phase", "previewBehavior")) return null
      if (payload.opt("type") != "machine_alert") return null
      val version = payload.opt("v") as? Number ?: return null
      if (version.toDouble() != 1.0) return null
      fun id(key: String) = (payload.opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
      val serverId = id("serverId") ?: return null
      val accountId = id("accountId") ?: return null
      val machineId = id("machineId") ?: return null
      val phase = payload.opt("phase") as? String ?: return null
      if (phase !in setOf("offline", "recovered")) return null
      val preview = payload.opt("previewBehavior") as? String ?: return null
      if (preview !in setOf("status_only", "title_only", "include_preview")) return null
      return MachineRemoteAlert(serverId, accountId, machineId, phase, preview)
    }
  }
}
