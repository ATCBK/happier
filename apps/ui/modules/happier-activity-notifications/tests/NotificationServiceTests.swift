import Foundation
import UserNotifications

private func makeRequest(userInfo: [AnyHashable: Any]) -> UNNotificationRequest {
  let content = UNMutableNotificationContent()
  content.title = "Happier"
  content.body = "A session you follow is ready."
  content.userInfo = userInfo
  return UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
}

private let readyAlert: [AnyHashable: Any] = [
  "type": "activity_alert",
  "v": 2,
  "serverId": "home-1",
  "sessionId": "session-1",
  "accountId": "account-1",
  "event": ["type": "ready", "sequenceDomain": "session_transcript", "messageSeq": 42],
  "previewBehavior": "status_only",
]

private func serializedBody(_ payload: [AnyHashable: Any]) -> String {
  let data = try! JSONSerialization.data(withJSONObject: payload)
  return String(data: data, encoding: .utf8)!
}

@main struct NotificationServiceTests {
  static func main() {
    var stalled = readyAlert
    stalled["event"] = ["type": "source_unavailable", "stalledOccurrence": ["turnId": "turn-a", "publisherFence": 123]]
    precondition(ActivityRemoteAlert(remoteUserInfo: ["body": stalled])?.eventIdentity == "stalled:turn-a:123",
                 "the original presence witness must keep the same cross-leg identity")
    stalled["event"] = ["type": "source_unavailable", "stalledOccurrence": ["turnId": "turn-a", "publisherFence": -1]]
    precondition(ActivityRemoteAlert(remoteUserInfo: ["body": stalled]) == nil, "invalid presence witness admitted")
    // A recognized alert keeps the Home's already-permitted copy and only gains
    // the canonical grouping identity.
    var delivered: UNNotificationContent?
    let service = HappierActivityNotificationService()
    // `expo-notifications` delivers the Expo `body` envelope to iOS as a JSON
    // object, not a string; a fixture that serializes it here would prove the
    // parser against a shape this platform never produces.
    let request = makeRequest(userInfo: ["body": readyAlert, "aps": ["mutable-content": 1]])
    service.didReceive(request) { delivered = $0 }
    precondition(delivered != nil, "the permitted alert was never delivered")
    precondition(delivered?.title == "Happier" && delivered?.body == "A session you follow is ready.",
                 "the consumer must not rewrite the submitted copy")
    precondition(delivered?.threadIdentifier == "activity_alert:home-1:session-1:ready",
                 "missing canonical replacement identity")

    // The same envelope carried as the serialized JSON string Expo uses for
    // Android alignment resolves through the one parser.
    var serializedDelivered: UNNotificationContent?
    HappierActivityNotificationService().didReceive(
      makeRequest(userInfo: ["body": serializedBody(readyAlert), "aps": ["mutable-content": 1]])
    ) { serializedDelivered = $0 }
    precondition(serializedDelivered?.threadIdentifier == "activity_alert:home-1:session-1:ready",
                 "the serialized Expo envelope lost alert grouping")

    // Malformed nested data is not an alert: the Home-approved generic copy is
    // delivered unchanged rather than enriched or dropped.
    var malformedDelivered: UNNotificationContent?
    let malformedRequest = makeRequest(userInfo: ["body": ["type": "activity_alert", "v": 2], "aps": ["mutable-content": 1]])
    HappierActivityNotificationService().didReceive(malformedRequest) { malformedDelivered = $0 }
    precondition(malformedDelivered === malformedRequest.content,
                 "a malformed nested envelope was admitted")
    precondition(malformedDelivered?.threadIdentifier.isEmpty == true,
                 "a malformed nested envelope gained alert grouping")

    // The remote service extension accepts only the nested Expo `body`
    // envelope. Locally scheduled alerts have their own top-level parser and
    // must never broaden remote admission.
    var topLevelRemoteDelivered: UNNotificationContent?
    let topLevelRemote = makeRequest(userInfo: readyAlert)
    HappierActivityNotificationService().didReceive(topLevelRemote) { topLevelRemoteDelivered = $0 }
    precondition(topLevelRemoteDelivered === topLevelRemote.content,
                 "the remote consumer admitted a top-level local envelope")
    precondition(topLevelRemoteDelivered?.threadIdentifier.isEmpty == true,
                 "a top-level remote envelope gained alert grouping")
    precondition(ActivityRemoteAlert(localUserInfo: readyAlert)?.threadIdentifier
                   == "activity_alert:home-1:session-1:ready",
                 "the local top-level parser rejected a canonical alert")

    // A Discussion sequence is scoped to one Discussion rather than to the
    // Session transcript. It must never be used to fetch a same-numbered,
    // unrelated Session message as notification preview content.
    let discussionAlertPayload: [AnyHashable: Any] = [
      "type": "activity_alert", "v": 2, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "discussion_mention", "sequenceDomain": "discussion", "discussionId": "discussion-a", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ]
    let discussionAlert = ActivityRemoteAlert(localUserInfo: discussionAlertPayload)
    precondition(discussionAlert != nil && discussionAlert?.canFetchSessionTranscriptPreview == false,
                 "a Discussion-local sequence must retain the generic fallback")
    let discussionHumanAlert = ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 2, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "human_message", "sequenceDomain": "discussion", "discussionId": "discussion-b", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ])
    precondition(discussionHumanAlert != nil && discussionHumanAlert?.canFetchSessionTranscriptPreview == false,
                 "a Discussion human post must not select the same-numbered Session transcript row")
    precondition(discussionAlert?.eventIdentity == "message-seq:discussion:discussion-a:1",
                 "the first Discussion lost its exact committed-event identity")
    precondition(discussionHumanAlert?.eventIdentity == "message-seq:discussion:discussion-b:1",
                 "equal sequences owned by different Discussions collided")
    precondition(ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 2, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "discussion_mention", "sequenceDomain": "discussion", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ]) == nil, "a current Discussion reference without its exact Discussion id was admitted")
    precondition(ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 2, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "discussion_mention", "sequenceDomain": "discussion", "discussionId": " ", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ]) == nil, "a current Discussion reference with an invalid Discussion id was admitted")
    let mainHumanAlert = ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 2, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "human_message", "sequenceDomain": "session_transcript", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ])
    precondition(mainHumanAlert != nil && mainHumanAlert?.canFetchSessionTranscriptPreview == true,
                 "an authenticated main-transcript human post lost preview enrichment")
    let legacyHumanAlert = ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "human_message", "messageSeq": 1],
      "previewBehavior": "include_preview",
    ])
    precondition(legacyHumanAlert != nil && legacyHumanAlert?.canFetchSessionTranscriptPreview == false,
                 "an ambiguous released payload must retain the generic fallback")

    // Both incumbent Account modes reach the same canonical Session-content
    // opener. Plain mode admits only an explicit null envelope; E2EE mode must
    // open the exact member envelope with the prepared machine key.
    let plainPrepared = ActivityPreparedHomeContext(
      serverId: "home-1", apiEndpoint: URL(string: "https://home.example")!, accountId: "account-1",
      token: "token", encryptionMode: "plain", machineKey: nil, settingsVersion: 1,
      accountEncryptionVersion: 1, registrationId: "registration", pushToken: "push",
      previewCeiling: "include_preview")
    precondition(ActivityNotificationEnricher.resolveContentKey(
      session: ["dataEncryptionKey": NSNull()], sessionMode: "plain", prepared: plainPrepared,
      openSessionDataKey: { _, _ in preconditionFailure("plain mode opened an E2EE envelope") }) == "")
    precondition(ActivityNotificationEnricher.resolveContentKey(
      session: ["dataEncryptionKey": "unexpected"], sessionMode: "plain", prepared: plainPrepared,
      openSessionDataKey: { _, _ in nil }) == nil)
    let encryptedPrepared = ActivityPreparedHomeContext(
      serverId: "home-1", apiEndpoint: URL(string: "https://home.example")!, accountId: "account-1",
      token: "token", encryptionMode: "e2ee", machineKey: "machine-key", settingsVersion: 1,
      accountEncryptionVersion: 1, registrationId: "registration", pushToken: "push",
      previewCeiling: "include_preview")

    let machinePayload: [AnyHashable: Any] = [
      "type": "machine_alert", "v": 1, "serverId": "home-1", "accountId": "account-1",
      "machineId": "machine-1", "phase": "offline", "previewBehavior": "status_only",
    ]
    let machineAlert = MachineRemoteAlert(remoteUserInfo: ["body": machinePayload])!
    var machineDelivered: UNNotificationContent?
    HappierActivityNotificationService().didReceive(makeRequest(userInfo: ["body": machinePayload])) {
      machineDelivered = $0
    }
    precondition(machineDelivered?.threadIdentifier == "machine_alert:home-1:account-1:machine-1",
                 "an offline Machine lost its exact Home/Account grouping")
    precondition(machineDelivered?.title == "Happier" && machineDelivered?.body == "A session you follow is ready.",
                 "a Machine alert changed the submitted generic fallback")
    var recoveredPayload = machinePayload
    recoveredPayload["phase"] = "recovered"
    precondition(MachineRemoteAlert(remoteUserInfo: ["body": serializedBody(recoveredPayload)])?.threadIdentifier
                   == machineAlert.threadIdentifier, "quiet recovery lost the established Machine identity")
    var returnDelivered: UNNotificationContent?
    HappierActivityNotificationService().didReceive(makeRequest(userInfo: ["body": recoveredPayload])) {
      returnDelivered = $0
    }
    precondition(returnDelivered?.threadIdentifier == machineAlert.threadIdentifier,
                 "a visible return notice lost the existing Machine notification grouping")
    for (key, invalid) in [("v", true as Any), ("machineId", " " as Any), ("unexpected", true as Any)] {
      var malformedMachine = machinePayload
      malformedMachine[key] = invalid
      precondition(MachineRemoteAlert(remoteUserInfo: ["body": malformedMachine]) == nil,
                   "an invalid Machine envelope gained native admission")
    }

    func plainMachineEnvelope(_ value: Any) -> String {
      try! JSONSerialization.data(withJSONObject: ["t": "plain", "v": value]).base64EncodedString()
    }
    var machine: [String: Any] = [
      "id": "machine-1", "kind": "persistent", "storageMode": "plain",
      "revokedAt": NSNull(), "replacedByMachineId": NSNull(),
      "dataEncryptionKey": plainMachineEnvelope(NSNull()),
      "metadata": plainMachineEnvelope(["displayName": " edge-1 ", "host": "host-1"]),
      "access": ["custodian": ["accountId": "account-1", "displayName": "Alice"],
                 "role": "manage", "resourceMode": "plain", "accessState": "ready"],
    ]
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: machine, alert: machineAlert, prepared: plainPrepared,
      openDataKey: { _, _ in preconditionFailure("plain Machine opened E2EE material") },
      decryptPayload: { _, _ in preconditionFailure("plain Machine decrypted ciphertext") }) == "edge-1")
    var runnerMachine = machine
    runnerMachine["kind"] = "ephemeral_session_runner"
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: runnerMachine, alert: machineAlert, prepared: plainPrepared,
      openDataKey: { _, _ in nil }, decryptPayload: { _, _ in nil }) == "edge-1",
      "an own Runner lost the same authenticated metadata reader")
    var foreignMachine = machine
    foreignMachine["access"] = ["custodian": ["accountId": "account-2", "displayName": "Bob"],
                                "role": "manage", "resourceMode": "plain", "accessState": "ready"]
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: foreignMachine, alert: machineAlert, prepared: plainPrepared,
      openDataKey: { _, _ in nil }, decryptPayload: { _, _ in nil }) == nil,
      "a different custodian's Machine disclosed its name")
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: machine, alert: machineAlert, prepared: encryptedPrepared,
      openDataKey: { _, _ in nil }, decryptPayload: { _, _ in nil }) == nil,
      "the Account mode/content mismatch was reinterpreted")
    machine["storageMode"] = "e2ee"
    machine["dataEncryptionKey"] = "machine-envelope"
    machine["metadata"] = "machine-ciphertext"
    machine["access"] = ["custodian": ["accountId": "account-1", "displayName": "Alice"],
                         "role": "manage", "resourceMode": "e2ee", "accessState": "ready"]
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: machine, alert: machineAlert, prepared: encryptedPrepared,
      openDataKey: { envelope, recipientKey in
        precondition(envelope == "machine-envelope" && recipientKey == "machine-key")
        return "machine-data-key"
      }, decryptPayload: { ciphertext, key in
        precondition(ciphertext == "machine-ciphertext" && key == "machine-data-key")
        return #"{"displayName":"","host":"encrypted-host"}"#
      }) == "encrypted-host")
    precondition(ActivityNotificationEnricher.openMachineName(
      machine: machine, alert: machineAlert, prepared: encryptedPrepared,
      openDataKey: { _, _ in nil }, decryptPayload: { _, _ in preconditionFailure("failed envelope decrypted") }) == nil)

    let assignedAlert = ActivityRemoteAlert(localUserInfo: [
      "type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
      "accountId": "account-1", "event": ["type": "assigned"], "previewBehavior": "title_only",
    ])!
    precondition(ActivityNotificationEnricher.isCurrentAssignment(
      session: ["responsibleAccountId": "account-1"], alert: assignedAlert),
      "current assignee was denied its rich assignment title")
    precondition(!ActivityNotificationEnricher.isCurrentAssignment(
      session: ["responsibleAccountId": "account-2"], alert: assignedAlert),
      "a delayed assignment alert revealed a rich title after reassignment")
    precondition(ActivityNotificationEnricher.isCurrentAssignment(
      session: ["responsibleAccountId": "account-2"], alert: ActivityRemoteAlert(localUserInfo: readyAlert)!),
      "non-assignment enrichment was coupled to responsibility")
    precondition(ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "plain", "version": 1, "settingsVersion": 1, "signingKeyFingerprint": NSNull(),
       "contentKeyFingerprint": NSNull(), "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "plain_account"]],
      prepared: plainPrepared), "plain prepared context rejected its exact current Account generation")
    precondition(!ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "plain", "version": 1, "settingsVersion": 2, "signingKeyFingerprint": NSNull(),
       "contentKeyFingerprint": NSNull(), "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "plain_account"]],
      prepared: plainPrepared), "stale notification privacy retained native preview authority")
    precondition(!ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "plain", "version": 1, "signingKeyFingerprint": NSNull(),
       "contentKeyFingerprint": NSNull(), "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "plain_account"]],
      prepared: plainPrepared), "missing notification settings currentness retained native preview authority")
    precondition(!ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "plain", "version": 1, "settingsVersion": "1", "signingKeyFingerprint": NSNull(),
       "contentKeyFingerprint": NSNull(), "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "plain_account"]],
      prepared: plainPrepared), "malformed notification settings currentness retained native preview authority")
    precondition(!ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "plain", "version": 2, "settingsVersion": 1, "signingKeyFingerprint": NSNull(),
       "contentKeyFingerprint": NSNull(), "updatedAt": 2,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "plain_account"]],
      prepared: plainPrepared), "rotated Account generation retained stale native preview authority")
    precondition(ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "e2ee", "version": 1, "settingsVersion": 1, "signingKeyFingerprint": "signing",
       "contentKeyFingerprint": "content", "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "available"]],
      prepared: encryptedPrepared), "E2EE prepared context rejected its exact current Account generation")
    precondition(!ActivityNotificationEnricher.isAccountEncryptionCurrent(
      ["mode": "e2ee", "version": 1, "settingsVersion": 1, "signingKeyFingerprint": "signing",
       "contentKeyFingerprint": "content", "updatedAt": 1,
       "recipientEnvelopeReadiness": ["status": "unavailable", "reason": "encryption_setup_required"]],
      prepared: encryptedPrepared), "unready recipient material retained native preview authority")
    precondition(ActivityNotificationEnricher.resolveContentKey(
      session: ["dataEncryptionKey": "member-envelope"], sessionMode: "e2ee", prepared: encryptedPrepared,
      openSessionDataKey: { envelope, machineKey in
        precondition(envelope == "member-envelope" && machineKey == "machine-key")
        return "session-key"
      }) == "session-key")
    precondition(ActivityNotificationEnricher.openContent(
      ["t": "plain", "v": ["role": "agent", "content": ["type": "text", "text": "plain"]]],
      contentKey: "", decryptSessionPayload: { _, _ in nil })?["role"] as? String == "agent")
    precondition(ActivityNotificationEnricher.openContent(
      ["t": "encrypted", "c": "ciphertext"], contentKey: "session-key",
      decryptSessionPayload: { ciphertext, key in
        precondition(ciphertext == "ciphertext" && key == "session-key")
        return #"{"role":"agent","content":{"type":"text","text":"encrypted"}}"#
      })?["role"] as? String == "agent")
    precondition(ActivityNotificationEnricher.openMetadataTitle(
      session: ["metadataLayoutVersion": 1, "metadata": #"{"v":1,"summary":{"text":"Plain title","updatedAt":1}}"#],
      contentKey: "", decryptSessionPayload: { _, _ in nil }) == "Plain title")
    precondition(ActivityNotificationEnricher.openMetadataTitle(
      session: ["metadataLayoutVersion": 1, "metadata": "metadata-ciphertext"],
      contentKey: "session-key", decryptSessionPayload: { ciphertext, key in
        precondition(ciphertext == "metadata-ciphertext" && key == "session-key")
        return #"{"v":1,"summary":{"text":"Encrypted title","updatedAt":1}}"#
      }) == "Encrypted title")

    // An expiring execution interval delivers the same permitted content rather
    // than dropping the alert or inventing a preview.
    var expired: UNNotificationContent?
    let expiring = HappierActivityNotificationService()
    expiring.didReceive(makeRequest(userInfo: ["body": serializedBody(readyAlert)])) { _ in }
    expiring.serviceExtensionTimeWillExpire()
    expiring.didReceive(makeRequest(userInfo: ["body": serializedBody(readyAlert)])) { expired = $0 }
    precondition(expired?.body == "A session you follow is ready.")

    // Anything outside the canonical contract is left exactly as received.
    for rejected in [
      ["type": "activity_alert", "v": 2] as [AnyHashable: Any],
      ["type": "badge_refresh"],
      ["type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
       "accountId": "account-1", "event": ["type": "human_message"], "previewBehavior": "hidden"],
      ["type": "activity_alert", "v": 1, "serverId": " ", "sessionId": "session-1",
       "accountId": "account-1", "event": ["type": "ready"], "previewBehavior": "hidden"],
      ["type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
       "accountId": "account-1", "event": ["type": "ready", "messageSeq": 42],
       "previewBehavior": "status_only", "unexpected": true],
      ["type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
       "accountId": "account-1", "event": ["type": "ready", "messageSeq": 0], "previewBehavior": "status_only"],
      ["type": "activity_alert", "v": 1, "serverId": "home-1", "sessionId": "session-1",
       "accountId": "account-1", "event": ["type": "permission_request", "messageSeq": 42],
       "previewBehavior": "status_only"],
    ] {
      var passthrough: UNNotificationContent?
      let untouched = HappierActivityNotificationService()
      let original = makeRequest(userInfo: rejected)
      untouched.didReceive(original) { passthrough = $0 }
      precondition(passthrough === original.content, "an unrecognized payload must be delivered untouched")
      precondition(passthrough?.threadIdentifier.isEmpty == true, "an unrecognized payload gained alert grouping")
    }

    print("NotificationServiceTests passed")
  }
}
