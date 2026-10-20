import ExpoModulesCore
import Foundation
import Darwin
import Security

@_silgen_name("happier_iroh_native_get_tunnel_status_json") private func irohTunnelStatus(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_create_endpoint_json") private func irohCreateEndpoint(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_ensure_home_tunnel_json") private func irohEnsureHomeTunnel(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_release_home_tunnel_json") private func irohReleaseHomeTunnel(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_shutdown_endpoint_json") private func irohShutdownEndpoint(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_start_machine_tunnel_json") private func irohStartMachineTunnel(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_start_machine_http_tunnel_json") private func irohStartMachineHttpTunnel(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_stop_machine_tunnel_json") private func irohStopMachineTunnel(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_wait_machine_tunnel_closed_json") private func irohWaitMachineTunnelClosed(_ request: UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
@_silgen_name("happier_iroh_native_free_string") private func irohFree(_ value: UnsafeMutablePointer<CChar>?)

/// Lifecycle/status only; tunnel bytes never cross this boundary.
public final class HappierIrohNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HappierIrohNative")
    Function("getAvailability") { () -> [String: Any] in
      let available = dlsym(dlopen(nil, RTLD_LAZY), "happier_iroh_native_create_endpoint_json") != nil
      return ["available": available, "platform": "ios", "engine": "iroh", "supportsHomeTunnel": available]
    }
    AsyncFunction("getTunnelStatus") { (_ tunnelId: String) async throws -> [String: Any]? in
      try callTunnelStatus(tunnelId)
    }
    AsyncFunction("createEndpoint") { (_ request: [String: Any]) async throws -> [String: Any] in
      try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
          do { continuation.resume(returning: try callWithEndpointIdentity(request, irohCreateEndpoint)) }
          catch { continuation.resume(throwing: error) }
        }
      }
    }
    AsyncFunction("ensureHomeTunnel") { (_ request: [String: Any]) async throws -> [String: Any] in
      try call(request, irohEnsureHomeTunnel)
    }
    AsyncFunction("releaseHomeTunnel") { (_ tunnelId: String) async throws -> Void in
      try callVoidJson(["tunnelId": tunnelId], irohReleaseHomeTunnel)
    }
    AsyncFunction("shutdownEndpoint") { (_ request: [String: Any]) async throws -> Void in
      _ = try call(request, irohShutdownEndpoint)
    }
    AsyncFunction("startMachineTunnel") { (_ request: [String: Any]) async throws -> [String: Any] in
      try call(request, irohStartMachineTunnel)
    }
    AsyncFunction("startMachineHttpTunnel") { (_ request: [String: Any]) async throws -> [String: Any] in
      try call(request, irohStartMachineHttpTunnel)
    }
    AsyncFunction("stopMachineTunnel") { (_ machineTunnelId: String) async throws -> Void in
      try callVoidJson(["machineTunnelId": machineTunnelId], irohStopMachineTunnel)
    }
    AsyncFunction("waitMachineTunnelClosed") { (_ machineTunnelId: String) async throws -> Void in
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
        DispatchQueue.global(qos: .utility).async {
          do {
            try callVoidJson(["machineTunnelId": machineTunnelId], irohWaitMachineTunnelClosed)
            continuation.resume(returning: ())
          } catch { continuation.resume(throwing: error) }
        }
      }
    }
  }
}

private enum IrohEndpointIdentityStore {
  // Fixed, namespaced, installation-only Keychain identity. It is deliberately
  // not synchronizable and never participates in iCloud Keychain migration.
  static let alias = "dev.happier.iroh.endpoint-identity.v1"
  private static let account = "installation-seed"
  private enum Existing { case found(Data), missing, failed }

  static func loadOrCreate() throws -> Data {
    switch loadExisting() {
    case .found(let data): return try validate(data)
    case .missing:
      var bytes = [UInt8](repeating: 0, count: 32)
      defer { bytes.withUnsafeMutableBytes { $0.initializeMemory(as: UInt8.self, repeating: 0) } }
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
        throw identityError(code: 1, message: "Iroh endpoint identity could not be provisioned.")
      }
      var seed = Data(bytes)
      defer { seed.resetBytes(in: 0..<seed.count) }
      let add: [CFString: Any] = [
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: alias,
        kSecAttrAccount: account,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        kSecAttrSynchronizable: kCFBooleanFalse as Any,
        kSecValueData: seed,
      ]
      let status = SecItemAdd(add as CFDictionary, nil)
      if status == errSecDuplicateItem {
        guard case .found(let existing) = loadExisting() else {
          throw identityError(code: 1, message: "Iroh endpoint identity is unavailable.")
        }
        return try validate(existing)
      }
      guard status == errSecSuccess else {
        throw identityError(code: 1, message: "Iroh endpoint identity could not be provisioned.")
      }
      return Data(seed)
    case .failed:
      throw identityError(code: 1, message: "Iroh endpoint identity is unavailable.")
    }
  }

  private static func loadExisting() -> Existing {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: alias,
      kSecAttrAccount: account,
      kSecAttrSynchronizable: kCFBooleanFalse as Any,
      kSecReturnData: kCFBooleanTrue as Any,
      kSecMatchLimit: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return .missing }
    guard status == errSecSuccess, let data = result as? Data else { return .failed }
    return .found(data)
  }

  private static func validate(_ data: Data) throws -> Data {
    guard data.count == 32 else {
      // Existing unreadable/corrupt identity is never deleted or rotated.
      throw identityError(code: 2, message: "Iroh endpoint identity is corrupt; secure-storage repair is required.")
    }
    return data
  }

  private static func identityError(code: Int, message: String) -> NSError {
    NSError(
      domain: "dev.happier.iroh.endpoint-identity",
      code: code,
      userInfo: ["code": "endpoint_key_unavailable", NSLocalizedDescriptionKey: message]
    )
  }
}

private func callWithEndpointIdentity(
  _ request: [String: Any],
  _ fn: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?
) throws -> [String: Any] {
  var seed = try IrohEndpointIdentityStore.loadOrCreate()
  defer { seed.resetBytes(in: 0..<seed.count) }
  var nativeRequest = request
  // Always overwrite any dynamically supplied value; only the native secure
  // store can provide the private seed to Rust.
  nativeRequest["endpointSeedBase64"] = seed.base64EncodedString()
  defer { nativeRequest.removeValue(forKey: "endpointSeedBase64") }
  return try call(nativeRequest, fn)
}

private func call(_ request: [String: Any], _ fn: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?) throws -> [String: Any] {
  let data = try JSONSerialization.data(withJSONObject: request)
  return try data.withUnsafeBytes { bytes in
    let input = String(decoding: bytes, as: UTF8.self)
    return try callString(input, fn).mapValues { $0 }
  }
}
private func callString(_ input: String, _ fn: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?) throws -> [String: Any] {
  let out = input.withCString { fn($0) }
  guard let out else { throw NSError(domain: "HappierIrohNative", code: 1) }
  defer { irohFree(out) }
  let data = Data(bytes: out, count: strlen(out))
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "HappierIrohNative", code: 2) }
  if object["ok"] as? Bool == true, let result = object["result"] as? [String: Any] { return result }
  throw nativeOperationError(object)
}

private func callVoid(_ input: String, _ fn: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?) throws {
  let out = input.withCString { fn($0) }
  guard let out else { throw NSError(domain: "HappierIrohNative", code: 1) }
  defer { irohFree(out) }
  let data = Data(bytes: out, count: strlen(out))
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw NSError(domain: "HappierIrohNative", code: 2)
  }
  guard object["ok"] as? Bool == true else { throw nativeOperationError(object) }
}

private func callVoidJson(_ input: [String: Any], _ fn: (UnsafePointer<CChar>) -> UnsafeMutablePointer<CChar>?) throws {
  let data = try JSONSerialization.data(withJSONObject: input)
  try callVoid(String(decoding: data, as: UTF8.self), fn)
}

/// Preserves the Rust JSON envelope's bounded code/message through NSError.
/// The prefixed description survives Expo's platform error normalization even
/// when `userInfo` is not projected into JavaScript; neither field contains
/// key bytes, payloads, endpoint seeds, or request material.
private func nativeOperationError(_ object: [String: Any]) -> NSError {
  let error = object["error"] as? [String: Any]
  let code = error?["code"] as? String ?? "unknown"
  let message = error?["message"] as? String ?? "Iroh native operation failed"
  return NSError(
    domain: "HappierIrohNative",
    code: 3,
    userInfo: [
      "code": code,
      NSLocalizedDescriptionKey: "iroh_native_error:\(code):\(message)",
    ]
  )
}

private func callTunnelStatus(_ tunnelId: String) throws -> [String: Any]? {
  let request = try JSONSerialization.data(withJSONObject: ["tunnelId": tunnelId])
  let input = String(decoding: request, as: UTF8.self)
  let out = input.withCString { irohTunnelStatus($0) }
  guard let out else { throw NSError(domain: "HappierIrohNative", code: 1) }
  defer { irohFree(out) }
  let data = Data(bytes: out, count: strlen(out))
  guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw NSError(domain: "HappierIrohNative", code: 2)
  }
  guard object["ok"] as? Bool == true else { throw nativeOperationError(object) }
  return object["result"] as? [String: Any]
}
