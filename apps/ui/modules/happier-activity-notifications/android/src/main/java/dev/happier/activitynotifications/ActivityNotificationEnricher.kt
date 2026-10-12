package dev.happier.activitynotifications

import android.content.Context
import android.net.Uri
import dev.happier.cryptoworker.HappierCryptoWorkerSessionCrypto
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

object ActivityNotificationEnricher {
  data class Enrichment(val title: String?, val body: String?)

  @JvmStatic fun enrichment(context: Context, alert: MachineRemoteAlert): Enrichment? {
    val prepared = ActivityPreparedContext.home(context, alert.serverId, alert.accountId) ?: return null
    if (alert.phase != "offline" || effectivePreviewBehavior(alert.previewBehavior, prepared.previewCeiling) == "status_only") return null
    val currentness = fetchJson(prepared.apiEndpoint.trimEnd('/') + "/v1/account/encryption/currentness", prepared.token) ?: return null
    if (!isAccountEncryptionCurrent(currentness, prepared)) return null
    val detail = fetchJson(prepared.apiEndpoint.trimEnd('/') + "/v1/machines/" + Uri.encode(alert.machineId), prepared.token, machineStoredContent = true) ?: return null
    val machine = detail.opt("machine") as? JSONObject ?: return null
    val name = openMachineName(machine, alert, prepared) ?: return null
    return Enrichment(name, null).takeIf {
      ActivityPreparedContext.home(context, alert.serverId, alert.accountId) == prepared
    }
  }

  @JvmStatic fun openMachineName(machine: JSONObject, alert: MachineRemoteAlert, prepared: ActivityPreparedHomeContext): String? {
    if (prepared.serverId != alert.serverId || prepared.accountId != alert.accountId) return null
    if (machine.requiredString("id") != alert.machineId || machine.opt("kind") !in setOf("persistent", "ephemeral_session_runner")
      || !machine.has("revokedAt") || !machine.isNull("revokedAt")
      || !machine.has("replacedByMachineId") || !machine.isNull("replacedByMachineId")) return null
    val access = machine.opt("access") as? JSONObject ?: return null
    val custodian = access.opt("custodian") as? JSONObject ?: return null
    if (!access.hasExactly("custodian", "role", "resourceMode", "accessState")
      || !custodian.hasExactly("accountId", "displayName") || custodian.opt("displayName") !is String
      || access.opt("role") != "manage") return null
    if (custodian.requiredString("accountId") != alert.accountId || access.opt("accessState") != "ready") return null
    val mode = machine.requiredString("storageMode") ?: return null
    if (access.opt("resourceMode") != mode) return null
    val stored = machine.requiredString("metadata") ?: return null
    val metadata = if (prepared.encryptionMode == "plain") {
      if (mode != "plain") return null
      val marker = machine.requiredString("dataEncryptionKey")?.let(::openPlainMachineEnvelope) ?: return null
      if (!marker.isNull("v")) return null
      openPlainMachineEnvelope(stored)?.opt("v") as? JSONObject ?: return null
    } else {
      if (prepared.encryptionMode !in setOf("e2ee", "legacy_e2ee") || mode != "e2ee") return null
      val envelope = machine.requiredString("dataEncryptionKey") ?: return null
      val recipientKey = prepared.machineKey ?: return null
      val key = HappierCryptoWorkerSessionCrypto.openSessionDataKey(envelope, recipientKey) ?: return null
      val serialized = HappierCryptoWorkerSessionCrypto.decryptMachinePayload(stored, key) ?: return null
      try { JSONObject(serialized) } catch (_: Throwable) { return null }
    }
    return (metadata.opt("displayName") as? String)?.trim()?.takeIf { it.isNotEmpty() }
      ?: (metadata.opt("host") as? String)?.trim()?.takeIf { it.isNotEmpty() }
  }

  private fun openPlainMachineEnvelope(encoded: String): JSONObject? = try {
    val decoded = android.util.Base64.decode(encoded, android.util.Base64.DEFAULT).toString(Charsets.UTF_8)
    JSONObject(decoded).takeIf { it.opt("t") == "plain" && it.has("v") }
  } catch (_: Throwable) { null }

  @JvmStatic fun enrichment(context: Context, alert: ActivityRemoteAlert): Enrichment? {
    val prepared = ActivityPreparedContext.home(context, alert.serverId, alert.accountId) ?: return null
    val enriched = enrichment(alert, prepared)
    // Local device privacy, credentials, or enrollment may change while the
    // bounded network/decryption work is in flight. Re-admit the exact prepared
    // generation before returning any rich content to the presenter.
    return enriched?.takeIf {
      ActivityPreparedContext.home(context, alert.serverId, alert.accountId) == prepared
    }
  }

  private fun enrichment(alert: ActivityRemoteAlert, prepared: ActivityPreparedHomeContext): Enrichment? {
    val effectivePreview = effectivePreviewBehavior(alert.previewBehavior, prepared.previewCeiling)
    if (effectivePreview == "status_only") return null

    val currentnessEndpoint = prepared.apiEndpoint.trimEnd('/') + "/v1/account/encryption/currentness"
    val currentness = fetchJson(currentnessEndpoint, prepared.token) ?: return null
    if (!isAccountEncryptionCurrent(currentness, prepared)) return null

    val detailEndpoint = prepared.apiEndpoint.trimEnd('/') + "/v2/sessions/" +
      Uri.encode(alert.sessionId) + "?accessProjectionVersion=1"
    val detail = fetchJson(detailEndpoint, prepared.token) ?: return null
    val session = detail.opt("session") as? JSONObject ?: return null
    if (session.requiredString("id") != alert.sessionId) return null
    val access = session.opt("effectiveAccess") as? JSONObject ?: return null
    if (access.exactLong("v") != 1L) return null
    val capabilities = access.opt("capabilities") as? JSONObject ?: return null
    if (capabilities.opt("readTranscript") !is Boolean || !capabilities.getBoolean("readTranscript")) return null
    if (!isCurrentAssignment(session, alert)) return null
    val sessionMode = session.requiredString("encryptionMode") ?: return null
    val contentKey = resolveContentKey(session, sessionMode, prepared) ?: return null

    val title = openMetadataTitle(session, contentKey)
    if (effectivePreview != "include_preview" || !alert.canFetchMessagePreview) {
      return title?.let { Enrichment(title = it, body = null) }
    }
    val sequence = alert.messageSeq?.toLong()?.takeIf { it > 0 }
      ?: return title?.let { Enrichment(title = it, body = null) }

    val messageEndpoint = if (alert.canFetchDiscussionPreview && alert.discussionId != null) {
      prepared.apiEndpoint.trimEnd('/') + "/v2/sessions/" + Uri.encode(alert.sessionId) +
        "/discussions/" + Uri.encode(alert.discussionId) +
        "/messages?afterSeq=" + (sequence - 1) + "&limit=1"
    } else if (alert.canFetchSessionTranscriptPreview) {
      prepared.apiEndpoint.trimEnd('/') + "/v1/sessions/" + Uri.encode(alert.sessionId) +
        "/messages?scope=main&afterSeq=" + (sequence - 1) + "&limit=1"
    } else return title?.let { Enrichment(title = it, body = null) }
    val root = fetchJson(messageEndpoint, prepared.token)
      ?: return title?.let { Enrichment(title = it, body = null) }
    val messages = root.optJSONArray("messages")
      ?: return title?.let { Enrichment(title = it, body = null) }
    val message = (0 until messages.length()).asSequence()
      .mapNotNull { messages.opt(it) as? JSONObject }
      .firstOrNull { it.exactLong("seq") == sequence }
      ?: return title?.let { Enrichment(title = it, body = null) }
    val content = message.opt("content") as? JSONObject
      ?: return title?.let { Enrichment(title = it, body = null) }
    val value = openContent(content, contentKey)
      ?: return title?.let { Enrichment(title = it, body = null) }
    val body = previewText(value.opt("content"))?.trim()?.takeIf { it.isNotEmpty() }
    return if (title == null && body == null) null else Enrichment(title, body)
  }

  @JvmStatic fun isCurrentAssignment(session: JSONObject, alert: ActivityRemoteAlert): Boolean =
    alert.eventType != "assigned" || session.opt("responsibleAccountId") == alert.accountId

  @JvmStatic fun isAccountEncryptionCurrent(
    root: JSONObject,
    prepared: ActivityPreparedHomeContext,
  ): Boolean {
    if (!root.hasExactly("mode", "version", "settingsVersion", "signingKeyFingerprint",
        "contentKeyFingerprint", "updatedAt", "recipientEnvelopeReadiness")) return false
    val mode = root.requiredString("mode") ?: return false
    if (root.exactLong("version") != prepared.accountEncryptionVersion || root.exactLong("updatedAt") == null) return false
    if (root.exactLong("settingsVersion") != prepared.settingsVersion) return false
    if (!root.isNull("signingKeyFingerprint") && root.requiredString("signingKeyFingerprint") == null) return false
    if (!root.isNull("contentKeyFingerprint") && root.requiredString("contentKeyFingerprint") == null) return false
    val readiness = root.opt("recipientEnvelopeReadiness") as? JSONObject ?: return false
    if (prepared.encryptionMode == "plain") {
      return mode == "plain" && readiness.hasExactly("status", "reason")
        && readiness.opt("status") == "unavailable" && readiness.opt("reason") == "plain_account"
    }
    return prepared.encryptionMode in setOf("e2ee", "legacy_e2ee") && mode == "e2ee"
      && readiness.hasExactly("status") && readiness.opt("status") == "available"
  }

  private fun effectivePreviewBehavior(submitted: String, prepared: String): String {
    val order = listOf("status_only", "title_only", "include_preview")
    val submittedIndex = order.indexOf(submitted)
    val preparedIndex = order.indexOf(prepared)
    return if (submittedIndex < 0 || preparedIndex < 0) "status_only" else order[minOf(submittedIndex, preparedIndex)]
  }

  // Empty string is the plain-mode marker; null always fails closed.
  private fun resolveContentKey(session: JSONObject, sessionMode: String,
                                prepared: ActivityPreparedHomeContext): String? {
    if (prepared.encryptionMode == "plain") {
      if (sessionMode != "plain" || !session.has("dataEncryptionKey") || !session.isNull("dataEncryptionKey")) return null
      return ""
    }
    if (prepared.encryptionMode !in setOf("e2ee", "legacy_e2ee") || sessionMode != "e2ee") return null
    val envelope = session.requiredString("dataEncryptionKey") ?: return null
    val machineKey = prepared.machineKey ?: return null
    return HappierCryptoWorkerSessionCrypto.openSessionDataKey(envelope, machineKey)
  }

  private fun openContent(content: JSONObject, contentKey: String): JSONObject? {
    if (contentKey.isEmpty()) {
      if (content.opt("t") != "plain") return null
      return content.opt("v") as? JSONObject
    }
    if (content.opt("t") != "encrypted") return null
    val ciphertext = content.requiredString("c") ?: return null
    val decrypted = HappierCryptoWorkerSessionCrypto.decryptSessionPayload(ciphertext, contentKey) ?: return null
    return try { JSONObject(decrypted) } catch (_: Throwable) { null }
  }

  private fun openMetadataTitle(session: JSONObject, contentKey: String): String? {
    if (session.exactLong("metadataLayoutVersion") != 1L) return null
    val stored = session.requiredString("metadata") ?: return null
    val serialized = if (contentKey.isEmpty()) stored
      else HappierCryptoWorkerSessionCrypto.decryptSessionPayload(stored, contentKey) ?: return null
    val metadata = try { JSONObject(serialized) } catch (_: Throwable) { return null }
    if (metadata.exactLong("v") != 1L) return null
    val summary = metadata.opt("summary") as? JSONObject ?: return null
    val title = (summary.opt("text") as? String)?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    return title
  }

  private fun fetchJson(endpoint: String, token: String, machineStoredContent: Boolean = false): JSONObject? {
    val connection = try { URL(endpoint).openConnection() as HttpURLConnection } catch (_: Throwable) { return null }
    return try {
      connection.connectTimeout = 2_500
      connection.readTimeout = 2_500
      connection.instanceFollowRedirects = false
      connection.setRequestProperty("Authorization", "Bearer $token")
      connection.setRequestProperty("Accept", "application/json")
      // V2 is the existing Plain Machine stored-content declaration; this read
      // consumes no newer protocol operations or unknown projection authority.
      if (machineStoredContent) connection.setRequestProperty("x-happier-account-stored-content-protocol", "2")
      if (connection.responseCode != 200) return null
      JSONObject(connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
    } catch (_: Throwable) {
      null
    } finally {
      connection.disconnect()
    }
  }

  private fun previewText(rawContent: Any?): String? = when (rawContent) {
    is JSONObject -> if (rawContent.opt("type") == "text") rawContent.opt("text") as? String else null
    is org.json.JSONArray -> (0 until rawContent.length()).asSequence()
      .mapNotNull { rawContent.opt(it) as? JSONObject }.firstOrNull { it.opt("type") == "text" }
      ?.opt("text") as? String
    else -> null
  }

  private fun JSONObject.requiredString(key: String): String? =
    (opt(key) as? String)?.takeIf { it.isNotEmpty() && it.trim() == it }

  private fun JSONObject.exactLong(key: String): Long? {
    val number = opt(key) as? Number ?: return null
    val value = number.toDouble()
    if (!value.isFinite() || value % 1.0 != 0.0 || value < 0 || value > Long.MAX_VALUE.toDouble()) return null
    return value.toLong()
  }

  private fun JSONObject.hasExactly(vararg keys: String): Boolean =
    keys().asSequence().toSet() == keys.toSet()
}
