import Foundation
import UniformTypeIdentifiers

/// Materialize provider-owned URLs while their scoped access is alive, just as the document picker does.
enum ComposerAttachmentDrop {
  static func read(_ url: URL) throws -> [String: Any] {
    guard url.isFileURL else { throw CocoaError(.fileReadUnsupportedScheme) }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    var coordinationError: NSError?
    var result: Result<[String: Any], Error>?
    NSFileCoordinator().coordinate(readingItemAt: url, options: .withoutChanges, error: &coordinationError) { coordinated in
      result = Result { try copySource(coordinated) }
    }
    if let coordinationError { throw coordinationError }
    guard let result else { throw CocoaError(.fileReadUnknown) }
    return try result.get()
  }

  private static func copySource(_ url: URL) throws -> [String: Any] {
    let files = FileManager.default
    let cache = try files.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("DocumentPicker", isDirectory: true).appendingPathComponent(UUID().uuidString, isDirectory: true)
    try files.createDirectory(at: cache, withIntermediateDirectories: true)
    do {
      let values = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
      guard values.isSymbolicLink != true else { throw CocoaError(.fileReadNoPermission) }
      if values.isDirectory != true { return try copyFile(url, into: cache) }
      var entries: [[String: Any]] = []
      var directories: [String] = []
      func visit(_ directory: URL, relative: String) throws {
        for child in try files.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) {
          let info = try child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
          guard info.isSymbolicLink != true else { throw CocoaError(.fileReadNoPermission) }
          let path = relative.isEmpty ? child.lastPathComponent : relative + "/" + child.lastPathComponent
          if info.isDirectory == true {
            directories.append(path)
            try visit(child, relative: path)
          } else {
            // Each file gets its own cache directory; relativePath alone owns tree placement at upload.
            let destination = cache.appendingPathComponent(UUID().uuidString, isDirectory: true)
            try files.createDirectory(at: destination, withIntermediateDirectories: true)
            entries.append(["relativePath": path, "source": try copyFile(child, into: destination)])
          }
        }
      }
      try visit(url, relative: "")
      return ["kind": "folder", "name": url.lastPathComponent, "mimeType": "inode/directory", "entries": entries, "directories": directories]
    } catch {
      try? files.removeItem(at: cache)
      throw error
    }
  }

  private static func copyFile(_ url: URL, into cache: URL) throws -> [String: Any] {
    let target = cache.appendingPathComponent(url.lastPathComponent)
    try FileManager.default.copyItem(at: url, to: target)
    let values = try target.resourceValues(forKeys: [.fileSizeKey])
    return ["kind": "native", "uri": target.absoluteString, "name": url.lastPathComponent,
            "sizeBytes": values.fileSize ?? 0, "mimeType": UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"]
  }
}
