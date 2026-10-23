package dev.happier.activitynotifications

import com.google.firebase.messaging.RemoteMessage
import org.json.JSONObject

/**
 * The committed canonical reference an Activity remote alert points at.
 *
 * Mirrors `ActivityRemoteAlert` in `packages/protocol/src/push/activityRemoteAlert.ts`,
 * the single owner of this wire shape. Admission is strict: anything this
 * consumer cannot recognize stays with the app's ordinary notification path
 * instead of being presented as an approved alert category.
 */
data class ActivityRemoteAlert(
  val serverId: String,
  val sessionId: String,
  val accountId: String,
  val eventType: String,
  val previewBehavior: String,
  val messageSeq: Int?,
  val sequenceDomain: String?,
  val discussionId: String?,
  val turnId: String?,
  val requestId: String?,
  val version: Int,
  val stalledTurnId: String? = null,
  val stalledPublisherFence: Long? = null,
) {
  /**
   * The platform replacement identity. Committed events with an exact reference
   * replace only that same reference; remaining current-state events retain the
   * category grouping. It is not a delivery receipt or exactly-once claim.
   */
  val replacementTag: String
    get() = "activity_alert:$serverId:$sessionId:${eventIdentity ?: eventType}"

  /**
   * Exact identity for a committed event reference, mirroring
   * `resolveActivityRemoteAlertEventIdentity` in the Protocol owner.
   *
   * A terminal turn is identified in both supported payload versions because
   * the turn id is unambiguous on its own; the released V1 sequence stays
   * category-grouped because it does not name its sequence owner.
   */
  val eventIdentity: String?
    get() = when {
      stalledTurnId != null && stalledPublisherFence != null -> "stalled:$stalledTurnId:$stalledPublisherFence"
      requestId != null -> if (turnId != null)
        "request-turn:${requestId.length}:$requestId:${turnId.length}:$turnId" else "request:$requestId"
      turnId != null && eventType in TURN_EVENT_TYPES -> "turn:$turnId"
      version != 2 || messageSeq == null -> null
      sequenceDomain == "discussion" && discussionId != null ->
        "message-seq:discussion:$discussionId:$messageSeq"
      sequenceDomain == "session_transcript" ->
        "message-seq:session_transcript:$messageSeq"
      else -> null
    }

  /**
   * Only current references with their complete owner identity may select a
   * message for local preview enrichment.
   */
  val canFetchSessionTranscriptPreview: Boolean
    get() = version == 2 && sequenceDomain == "session_transcript" &&
      eventType in setOf("ready", "human_message", "message")

  val canFetchDiscussionPreview: Boolean
    get() = version == 2 && sequenceDomain == "discussion" && discussionId != null &&
      eventType in setOf("human_message", "message", "discussion_mention")

  val canFetchMessagePreview: Boolean
    get() = canFetchSessionTranscriptPreview || canFetchDiscussionPreview

  companion object {
    val SUPPORTED_EVENT_TYPES = setOf("ready", "permission_request", "user_action_request", "assigned", "failed", "cancelled", "human_message", "message", "discussion_mention", "source_unavailable")
    private val SEQUENCED_EVENT_TYPES = setOf("ready", "human_message", "message", "discussion_mention")
    private val TURN_EVENT_TYPES = setOf("failed", "cancelled")
    private val REQUEST_EVENT_TYPES = setOf("permission_request", "user_action_request")
    private val SUPPORTED_PREVIEW_BEHAVIORS = setOf("status_only", "title_only", "include_preview")

    @JvmStatic
    fun parse(remoteMessage: RemoteMessage): ActivityRemoteAlert? {
      val raw = remoteMessage.data["body"] ?: return null
      val payload = try {
        JSONObject(raw)
      } catch (_: Throwable) {
        return null
      }
      if (!payload.hasExactly("type", "v", "serverId", "sessionId", "accountId", "event", "previewBehavior")) return null
      val version = payload.requiredPositiveInt("v") ?: return null
      if (payload.requiredString("type") != "activity_alert" || version !in setOf(1, 2)) return null
      val serverId = payload.requiredString("serverId") ?: return null
      val sessionId = payload.requiredString("sessionId") ?: return null
      val accountId = payload.requiredString("accountId") ?: return null
      val event = payload.opt("event") as? JSONObject ?: return null
      val eventType = event.requiredString("type") ?: return null
      if (eventType !in SUPPORTED_EVENT_TYPES) return null
      val previewBehavior = payload.requiredString("previewBehavior") ?: return null
      if (previewBehavior !in SUPPORTED_PREVIEW_BEHAVIORS) return null
      var sequenceDomain: String? = null
      var discussionId: String? = null
      var turnId: String? = null
      var requestId: String? = null
      var stalledTurnId: String? = null
      var stalledPublisherFence: Long? = null
      val messageSeq = if (eventType in SEQUENCED_EVENT_TYPES) {
        if (version == 1) {
          if (!event.hasExactly("type", "messageSeq")) return null
        } else {
          sequenceDomain = event.requiredString("sequenceDomain") ?: return null
          if (sequenceDomain == "session_transcript") {
            if (!event.hasExactly("type", "sequenceDomain", "messageSeq") ||
              eventType == "discussion_mention") return null
          } else if (sequenceDomain == "discussion") {
            if (!event.hasExactly("type", "sequenceDomain", "discussionId", "messageSeq") ||
              eventType == "ready") return null
            discussionId = event.requiredBoundedIdentifier("discussionId") ?: return null
          } else return null
        }
        event.requiredPositiveInt("messageSeq") ?: return null
      } else if (eventType in TURN_EVENT_TYPES) {
        if (!event.hasExactly("type", "turnId")) return null
        turnId = event.requiredString("turnId") ?: return null
        null
      } else if (version == 2 && eventType in REQUEST_EVENT_TYPES) {
        // The committed request id is optional in the wire union, so both the
        // bare category and the identified request are admitted.
        val keys = mutableListOf("type")
        if (event.has("requestId")) {
          requestId = event.requiredBoundedIdentifier("requestId") ?: return null
          keys.add("requestId")
        }
        if (event.has("turnId")) {
          turnId = event.requiredBoundedIdentifier("turnId") ?: return null
          if (event.opt("turnId") != turnId) return null
          keys.add("turnId")
        }
        if (!event.hasExactly(*keys.toTypedArray())) return null
        null
      } else if (version == 2 && eventType == "source_unavailable" && event.has("stalledOccurrence")) {
        if (!event.hasExactly("type", "stalledOccurrence")) return null
        val occurrence = event.opt("stalledOccurrence") as? JSONObject ?: return null
        if (!occurrence.hasExactly("turnId", "publisherFence")) return null
        stalledTurnId = occurrence.requiredBoundedIdentifier("turnId") ?: return null
        val fence = (occurrence.opt("publisherFence") as? Number)?.toDouble() ?: return null
        if (!fence.isFinite() || fence % 1.0 != 0.0 || fence < 0 || fence > 9_007_199_254_740_991.0) return null
        stalledPublisherFence = fence.toLong()
        null
      } else if (!event.hasExactly("type")) return null
      else null
      return ActivityRemoteAlert(
        serverId, sessionId, accountId, eventType, previewBehavior,
        messageSeq, sequenceDomain, discussionId, turnId, requestId, version, stalledTurnId, stalledPublisherFence,
      )
    }

    private fun JSONObject.requiredString(key: String): String? {
      val value = (opt(key) as? String)?.trim() ?: return null
      return value.ifEmpty { null }
    }

    private fun JSONObject.requiredBoundedIdentifier(key: String): String? =
      requiredString(key)?.takeIf { it.length <= 191 }

    private fun JSONObject.requiredPositiveInt(key: String): Int? {
      val value = opt(key) as? Number ?: return null
      val doubleValue = value.toDouble()
      if (!doubleValue.isFinite() || doubleValue % 1.0 != 0.0
        || doubleValue <= 0.0 || doubleValue > Int.MAX_VALUE.toDouble()) return null
      return doubleValue.toInt()
    }

    private fun JSONObject.hasExactly(vararg keys: String): Boolean {
      val expected = keys.toSet()
      val actual = keys().asSequence().toSet()
      return actual == expected
    }
  }
}
