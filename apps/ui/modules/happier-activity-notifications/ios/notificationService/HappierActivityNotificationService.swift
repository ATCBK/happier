import UserNotifications
import CoreFoundation

/// Separate closed Machine alert V1; Session alert epochs remain unchanged.
struct MachineRemoteAlert {
  let serverId: String
  let accountId: String
  let machineId: String
  let phase: String
  let previewBehavior: String
  var threadIdentifier: String { "machine_alert:\(serverId):\(accountId):\(machineId)" }

  init?(remoteUserInfo: [AnyHashable: Any]) {
    let payload: [String: Any]
    if let object = remoteUserInfo["body"] as? [String: Any] { payload = object }
    else if let serialized = remoteUserInfo["body"] as? String,
            let data = serialized.data(using: .utf8),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { payload = object }
    else { return nil }
    guard Set(payload.keys) == Set(["type", "v", "serverId", "accountId", "machineId", "phase", "previewBehavior"]),
          payload["type"] as? String == "machine_alert",
          let version = payload["v"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(),
          version.doubleValue == 1,
          let serverId = (payload["serverId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !serverId.isEmpty,
          let accountId = (payload["accountId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !accountId.isEmpty,
          let machineId = (payload["machineId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !machineId.isEmpty,
          let phase = payload["phase"] as? String, ["offline", "recovered"].contains(phase),
          let preview = payload["previewBehavior"] as? String,
          ["status_only", "title_only", "include_preview"].contains(preview) else { return nil }
    self.serverId = serverId
    self.accountId = accountId
    self.machineId = machineId
    self.phase = phase
    self.previewBehavior = preview
  }
}

/// The committed canonical reference an Activity remote alert points at.
///
/// Mirrors `ActivityRemoteAlert` in `packages/protocol/src/push/activityRemoteAlert.ts`,
/// the single owner of this wire shape. Admission is strict so an unrecognized
/// payload is left exactly as the OS received it.
struct ActivityRemoteAlert {
  static let supportedEventTypes = Set(ActivityNotificationEvents.supported)

  let serverId: String
  let sessionId: String
  let accountId: String
  let eventType: String
  let previewBehavior: String
  let messageSeq: Int64?
  let sequenceDomain: String?
  let discussionId: String?
  let requestId: String?
  let requestTurnId: String?
  let stalledTurnId: String?
  let stalledPublisherFence: Int64?
  let version: Int64

  private static let supportedPreviewBehaviors = Set(["status_only", "title_only", "include_preview"])

  /// Groups every alert for one Home, Session and category. iOS replacement of an
  /// already delivered alert needs an APNs collapse identifier on the submitting
  /// leg; a thread identifier only groups what is presented.
  var threadIdentifier: String { "activity_alert:\(serverId):\(sessionId):\(eventType)" }

  /// Exact identity for a current committed message reference. This is not a
  /// delivery receipt; it keeps equal local sequences owned by two Discussions
  /// distinct for presentation dedupe and diagnostics.
  var eventIdentity: String? {
    if let stalledTurnId, let stalledPublisherFence { return "stalled:\(stalledTurnId):\(stalledPublisherFence)" }
    if version == 2, let requestId,
       ["permission_request", "user_action_request"].contains(eventType) {
      if let requestTurnId {
        return "request-turn:\(requestId.utf16.count):\(requestId):\(requestTurnId.utf16.count):\(requestTurnId)"
      }
      return "request:\(requestId)"
    }
    guard version == 2, let messageSeq else { return nil }
    if sequenceDomain == "discussion", let discussionId {
      return "message-seq:discussion:\(discussionId):\(messageSeq)"
    }
    if sequenceDomain == "session_transcript" {
      return "message-seq:session_transcript:\(messageSeq)"
    }
    return nil
  }

  /// Only current references with their complete owner identity may select a
  /// message for local preview enrichment.
  var canFetchSessionTranscriptPreview: Bool {
    version == 2
      && sequenceDomain == "session_transcript"
      && ["ready", "human_message", "message"].contains(eventType)
  }

  var canFetchDiscussionPreview: Bool {
    version == 2
      && sequenceDomain == "discussion"
      && discussionId != nil
      && ["human_message", "message", "discussion_mention"].contains(eventType)
  }

  var canFetchMessagePreview: Bool {
    canFetchSessionTranscriptPreview || canFetchDiscussionPreview
  }

  /// APNs/Expo remote delivery nests the canonical object under `body`.
  /// Requiring that envelope here prevents a remote top-level object from being
  /// mistaken for the separate local-notification representation.
  ///
  /// On iOS the nested value is a JSON object, not a string: `expo-notifications`
  /// reads it as `userInfo["body"] as? [String: Any]`
  /// (`ios/ExpoNotifications/Notifications/NotificationRecords.swift`) and
  /// serializes it to a string only when building the JS background
  /// representation, "for alignment with Android"
  /// (`.../Background/BackgroundEventTransformer.swift`). Both encodings are
  /// admitted through the one parser below so this extension never depends on
  /// which representation a given delivery path produced.
  init?(remoteUserInfo: [AnyHashable: Any]) {
    if let nestedObject = remoteUserInfo["body"] as? [String: Any] {
      self.init(payload: nestedObject)
      return
    }
    guard let serializedBody = remoteUserInfo["body"] as? String,
          let data = serializedBody.data(using: .utf8),
          let decoded = try? JSONSerialization.jsonObject(with: data),
          let decodedObject = decoded as? [String: Any] else { return nil }
    self.init(payload: decodedObject)
  }

  /// Locally scheduled notifications use the canonical object at top level.
  init?(localUserInfo: [AnyHashable: Any]) {
    self.init(payload: localUserInfo)
  }

  private init?(payload: [AnyHashable: Any]) {
    guard ActivityRemoteAlert.exactKeys(
      payload,
      allowed: ["type", "v", "serverId", "sessionId", "accountId", "event", "previewBehavior"]
    ) else { return nil }
    guard payload["type"] as? String == "activity_alert",
          let version = ActivityRemoteAlert.exactInteger(payload["v"]), [1, 2].contains(version),
          let serverId = ActivityRemoteAlert.requiredString(payload["serverId"]),
          let sessionId = ActivityRemoteAlert.requiredString(payload["sessionId"]),
          let accountId = ActivityRemoteAlert.requiredString(payload["accountId"]),
          let event = payload["event"] as? [AnyHashable: Any],
          let eventType = ActivityRemoteAlert.requiredString(event["type"]),
          ActivityRemoteAlert.supportedEventTypes.contains(eventType),
          let previewBehavior = ActivityRemoteAlert.requiredString(payload["previewBehavior"]),
          ActivityRemoteAlert.supportedPreviewBehaviors.contains(previewBehavior),
          ActivityRemoteAlert.validEventShape(event, type: eventType, version: version) else {
      return nil
    }
    self.serverId = serverId
    self.sessionId = sessionId
    self.accountId = accountId
    self.eventType = eventType
    self.previewBehavior = previewBehavior
    self.version = version
    self.messageSeq = ["ready", "human_message", "message", "discussion_mention"].contains(eventType)
      ? ActivityRemoteAlert.exactInteger(event["messageSeq"])
      : nil
    self.sequenceDomain = version == 2 && self.messageSeq != nil
      ? ActivityRemoteAlert.requiredString(event["sequenceDomain"])
      : nil
    self.discussionId = version == 2 && self.sequenceDomain == "discussion"
      ? ActivityRemoteAlert.requiredBoundedIdentifier(event["discussionId"])
      : nil
    self.requestId = version == 2 && ["permission_request", "user_action_request"].contains(eventType)
      ? ActivityRemoteAlert.requiredBoundedIdentifier(event["requestId"])
      : nil
    self.requestTurnId = version == 2 && ["permission_request", "user_action_request"].contains(eventType)
      ? ActivityRemoteAlert.requiredRequestTurnId(event["turnId"])
      : nil
    let stalled = version == 2 && eventType == "source_unavailable" ? event["stalledOccurrence"] as? [String: Any] : nil
    self.stalledTurnId = ActivityRemoteAlert.requiredBoundedIdentifier(stalled?["turnId"])
    self.stalledPublisherFence = ActivityRemoteAlert.exactInteger(stalled?["publisherFence"])
  }

  private static func requiredRequestTurnId(_ value: Any?) -> String? {
    guard let turnId = requiredBoundedIdentifier(value),
          let raw = value as? String, raw == turnId else { return nil }
    return turnId
  }

  private static func requiredString(_ value: Any?) -> String? {
    guard let text = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
      return nil
    }
    return text
  }

  /// One bounded-identifier admission for every id the wire union carries.
  private static func requiredBoundedIdentifier(_ value: Any?) -> String? {
    guard let text = requiredString(value), text.utf16.count <= 191 else { return nil }
    return text
  }

  private static func exactInteger(_ value: Any?) -> Int64? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double.rounded() == double,
          double >= Double(Int64.min), double <= Double(Int64.max) else { return nil }
    return number.int64Value
  }

  private static func exactKeys(_ value: [AnyHashable: Any], allowed: Set<String>) -> Bool {
    Set(value.keys.compactMap { $0 as? String }) == allowed && value.keys.allSatisfy { $0 is String }
  }

  private static func validEventShape(_ event: [AnyHashable: Any], type: String, version: Int64) -> Bool {
    if ["ready", "human_message", "message", "discussion_mention"].contains(type) {
      guard let sequence = exactInteger(event["messageSeq"]),
            sequence > 0 && sequence <= 2_147_483_647 else { return false }
      if version == 1 {
        return exactKeys(event, allowed: ["type", "messageSeq"])
      }
      guard let domain = requiredString(event["sequenceDomain"]) else { return false }
      if domain == "session_transcript" {
        return exactKeys(event, allowed: ["type", "sequenceDomain", "messageSeq"])
          && type != "discussion_mention"
      }
      return domain == "discussion"
        && type != "ready"
        && exactKeys(event, allowed: ["type", "sequenceDomain", "discussionId", "messageSeq"])
        && requiredBoundedIdentifier(event["discussionId"]) != nil
    }
    if ["failed", "cancelled"].contains(type) {
      return exactKeys(event, allowed: ["type", "turnId"])
        && requiredString(event["turnId"]) != nil
    }
    // The committed request id is optional in the wire union, so a payload that
    // carries it must still be admitted; a present but invalid one is not.
    if version == 2 && ["permission_request", "user_action_request"].contains(type) {
      var allowed = Set(["type"])
      if let requestId = event["requestId"] {
        guard requiredBoundedIdentifier(requestId) != nil else { return false }
        allowed.insert("requestId")
      }
      if let turnId = event["turnId"] {
        guard requiredRequestTurnId(turnId) != nil else { return false }
        allowed.insert("turnId")
      }
      return exactKeys(event, allowed: allowed)
    }
    if version == 2 && type == "source_unavailable", let raw = event["stalledOccurrence"] {
      guard exactKeys(event, allowed: ["type", "stalledOccurrence"]),
            let occurrence = raw as? [AnyHashable: Any], exactKeys(occurrence, allowed: ["turnId", "publisherFence"]),
            requiredBoundedIdentifier(occurrence["turnId"]) != nil,
            let fence = exactInteger(occurrence["publisherFence"]), fence >= 0, fence <= 9_007_199_254_740_991 else { return false }
      return true
    }
    return exactKeys(event, allowed: ["type"])
  }
}

/// The iOS consumer for the Home's Activity remote alert leg.
///
/// The submitted alert already passed the recipient's mute, quiet-hours and
/// preview decision before submission, so this extension never suppresses it and
/// never invents content: an unrecognized payload, a missing enrichment input or
/// an expiring execution interval all deliver the already-permitted content.
///
class HappierActivityNotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var deliverableContent: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    self.deliverableContent = request.content

    if let machine = MachineRemoteAlert(remoteUserInfo: request.content.userInfo),
       !request.content.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
       let content = request.content.mutableCopy() as? UNMutableNotificationContent {
      content.threadIdentifier = machine.threadIdentifier
      self.deliverableContent = content
      guard let root = ActivityNotificationStorageLocation.appGroupRoot(bundle: .main, fileManager: .default),
            let prepared = ActivityPreparedContext.home(root: root, serverId: machine.serverId, accountId: machine.accountId) else {
        finish(content)
        return
      }
      ActivityNotificationEnricher.fetchEnrichment(alert: machine, prepared: prepared) { [weak self] enrichment in
        guard let self else { return }
        if ActivityPreparedContext.home(root: root, serverId: machine.serverId, accountId: machine.accountId) == prepared,
           let title = enrichment?.title { content.title = title }
        self.finish(content)
      }
      return
    }
    // Ordinary recovery has no APNs alert; the existing app background task
    // dismisses offline notices. Requested return alerts use the same grouping.

    guard let alert = ActivityRemoteAlert(remoteUserInfo: request.content.userInfo),
          let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      finish(request.content)
      return
    }
    // Admission to enrichment is exact-Home and current-context bound. Missing,
    // locked, malformed or revoked prepared custody keeps the Home-approved
    // generic fallback; it never broadens preview locally.
    guard let root = ActivityNotificationStorageLocation.appGroupRoot(bundle: .main, fileManager: .default),
          let prepared = ActivityPreparedContext.home(
            root: root, serverId: alert.serverId, accountId: alert.accountId
          ), prepared.previewCeiling != "status_only" else {
      content.threadIdentifier = alert.threadIdentifier
      self.deliverableContent = content
      finish(content)
      return
    }
    content.threadIdentifier = alert.threadIdentifier
    self.deliverableContent = content
    ActivityNotificationEnricher.fetchEnrichment(alert: alert, prepared: prepared) { [weak self] enrichment in
      guard let self else { return }
      // Local device privacy, credentials, or enrollment may change while the
      // bounded network/decryption work is in flight. The captured generation
      // no longer authorizes rich content once its exact prepared row moved.
      guard ActivityPreparedContext.home(
        root: root, serverId: alert.serverId, accountId: alert.accountId
      ) == prepared else {
        self.finish(content)
        return
      }
      if let title = enrichment?.title { content.title = title }
      if let body = enrichment?.body { content.body = body }
      self.finish(content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    guard contentHandler != nil, let deliverableContent else { return }
    finish(deliverableContent)
  }

  private func finish(_ content: UNNotificationContent) {
    guard let handler = contentHandler else { return }
    contentHandler = nil
    handler(content)
  }
}
