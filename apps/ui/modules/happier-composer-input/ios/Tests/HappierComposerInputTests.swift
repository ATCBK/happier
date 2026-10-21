import UIKit
import XCTest
import UniformTypeIdentifiers
@testable import HappierComposerInputNative

@MainActor
final class HappierComposerInputTests: XCTestCase {
  private let token = "[Auth](happier-ref:session:auth)"

  func testDirectoryDropCopiesScopedFilesIntoTheSharedFolderSourceShapeIncludingEmptyDirectories() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("Design")
    try FileManager.default.createDirectory(at: root.appendingPathComponent("icons/empty"), withIntermediateDirectories: true)
    try Data("svg".utf8).write(to: root.appendingPathComponent("icons/a.svg"))
    defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
    let source = try ComposerAttachmentDrop.read(root)
    XCTAssertEqual(source["kind"] as? String, "folder")
    XCTAssertEqual(source["name"] as? String, "Design")
    XCTAssertEqual(source["mimeType"] as? String, "inode/directory")
    XCTAssertEqual(Set(source["directories"] as? [String] ?? []), Set(["icons", "icons/empty"]))
    let entries = try XCTUnwrap(source["entries"] as? [[String: Any]])
    XCTAssertEqual(entries.count, 1)
    XCTAssertEqual(entries[0]["relativePath"] as? String, "icons/a.svg")
    let file = try XCTUnwrap(entries[0]["source"] as? [String: Any])
    XCTAssertEqual(file["kind"] as? String, "native")
    XCTAssertEqual(file["sizeBytes"] as? Int, 3)
    let cached = try XCTUnwrap(URL(string: try XCTUnwrap(file["uri"] as? String)))
    defer { try? FileManager.default.removeItem(at: cached.deletingLastPathComponent().deletingLastPathComponent()) }
    try FileManager.default.removeItem(at: root.appendingPathComponent("icons/a.svg"))
    XCTAssertEqual(try Data(contentsOf: cached), Data("svg".utf8))
  }

  func testNativeDropInteractionAdmitsFilesButRefusesRichTextProviders() {
    let input = makeInput()
    XCTAssertTrue(input.interactions.contains { $0 is UIDropInteraction && ($0 as? UIDropInteraction)?.delegate === input })
    let rich = NSItemProvider(item: "<b>foreign</b>" as NSString, typeIdentifier: UTType.html.identifier)
    XCTAssertNil(input.attachmentDropType(rich))
    let folder = NSItemProvider()
    folder.registerFileRepresentation(forTypeIdentifier: UTType.folder.identifier, fileOptions: .openInPlace, visibility: .all) { _ in nil }
    XCTAssertEqual(input.attachmentDropType(folder), UTType.folder.identifier)
  }

  private func makeInput(prefix: String = "😀 ", suffix: String = " done") -> HappierComposerTextView {
    let input = HappierComposerTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 120))
    let start = (prefix as NSString).length
    input.setReferences([[
      "start": start, "end": start + (token as NSString).length,
      "ref": "session:auth", "kind": "session", "label": "Auth", "state": "ready",
      "marker": "@Session \"Auth\"", "accessibilityLabel": "Session, Auth",
    ]])
    input.setControlledText(prefix + token + suffix)
    return input
  }

  func testActualTextViewUsesAnAttachmentAndReportsUTF16SourceSelection() {
    let input = makeInput()
    XCTAssertEqual(input.text, "😀 \u{fffc} done")
    XCTAssertNotNil(input.textStorage.attribute(.attachment, at: 3, effectiveRange: nil))
    input.setSourceSelection(["start": 4, "end": 4])
    XCTAssertEqual(input.sourceSelection["start"], 3)
    input.selectedRange = NSRange(location: 4, length: 0)
    XCTAssertEqual(input.sourceSelection["start"], 3 + (token as NSString).length)
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
  }

  func testSoftKeyboardBackspaceSelectsThenDeletesTheWholeChipAndUndoRestoresIt() {
    let input = makeInput()
    input.selectedRange = NSRange(location: 4, length: 0)
    input.deleteBackward()
    XCTAssertEqual(input.selectedRange, NSRange(location: 3, length: 1))
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
    input.deleteBackward()
    XCTAssertEqual(input.sourceText, "😀  done")
    XCTAssertEqual(input.sourceSelection["start"], 3)
    input.undoManager?.undo()
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
    let restored = input.referenceSnapshots()
    XCTAssertEqual(restored.count, 1)
    XCTAssertEqual(restored.first?["ref"] as? String, "session:auth")
    XCTAssertEqual(restored.first?["token"] as? String, token)
    XCTAssertEqual(restored.first?["start"] as? Int, 3)
  }

  func testReplacingASelectionAcrossChipNeverLeaksItsTokenCharacters() {
    let input = makeInput()
    input.selectedRange = NSRange(location: 2, length: 3)
    input.insertText("new ")
    XCTAssertEqual(input.sourceText, "😀new done")
    XCTAssertFalse(input.sourceText.contains("happier-ref:"))
  }

  func testControlledUpdatesWaitUntilMarkedTextIsCommitted() {
    let input = makeInput(prefix: "", suffix: "")
    input.selectedRange = NSRange(location: 1, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    XCTAssertNotNil(input.markedTextRange)
    input.setControlledText("external")
    XCTAssertTrue(input.sourceText.contains("に"))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, "external")
  }

  func testStaleControlledCompositionEchoCannotRestoreAnEarlierMarkedValue() {
    let input = makeInput(prefix: "", suffix: "")
    input.selectedRange = NSRange(location: 1, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    let intermediate = input.sourceText
    let acknowledgedEvent = input.eventCount
    input.setControlledText(intermediate, eventCount: acknowledgedEvent)
    input.setMarkedText("日本", selectedRange: NSRange(location: 2, length: 0))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, token + "日本")
    input.setControlledText(intermediate, eventCount: acknowledgedEvent)
    XCTAssertEqual(input.sourceText, token + "日本")
  }

  func testIntentionalTextAndSelectionCommandWaitsForCompositionThenApplies() {
    let input = makeInput()
    input.selectedRange = NSRange(location: 4, length: 0)
    input.setMarkedText("に", selectedRange: NSRange(location: 1, length: 0))
    input.setTextAndSelection("New draft", selection: ["start": 4, "end": 4])
    XCTAssertTrue(input.sourceText.contains("に"))
    input.unmarkText()
    XCTAssertEqual(input.sourceText, "New draft")
    XCTAssertEqual(input.sourceSelection, ["start": 4, "end": 4])
  }

  func testAdjacentChipsCRLFAndEmojiRemainInOneSourceOffsetSpace() {
    let input = makeInput(prefix: "", suffix: token + "\r\n😀")
    let length = (token as NSString).length
    input.setReferences([
      ["start": 0, "end": length, "ref": "session:auth", "label": "Auth"],
      ["start": length, "end": length * 2, "ref": "session:auth", "label": "Auth"],
    ])
    XCTAssertEqual(input.text, "\u{fffc}\u{fffc}\r\n😀")
    input.setSourceSelection(["start": length - 1, "end": length + 1])
    XCTAssertEqual(input.selectedRange, NSRange(location: 0, length: 2))
    XCTAssertEqual(input.sourceSelection, ["start": 0, "end": length * 2])
    input.selectedRange = NSRange(location: 6, length: 0)
    XCTAssertEqual(input.sourceSelection["start"], length * 2 + 4)
  }

  func testReferenceRangeEchoAfterTypingKeepsTheActualAttachmentAndUndo() {
    let input = makeInput()
    let attachment = input.textStorage.attribute(.attachment, at: 3, effectiveRange: nil) as? NSTextAttachment
    input.selectedRange = NSRange(location: 0, length: 0)
    input.insertText("Hi ")
    input.setReferences([["start": 6, "end": 6 + (token as NSString).length,
                          "ref": "session:auth", "label": "Updated"]])
    let retained = input.textStorage.attribute(.attachment, at: 6, effectiveRange: nil) as? NSTextAttachment
    XCTAssertTrue(attachment === retained)
    input.undoManager?.undo()
    XCTAssertEqual(input.sourceText, "😀 " + token + " done")
  }

  func testPlainClipboardProjectionDoesNotRebuildChipsOnPaste() {
    let input = makeInput(prefix: "", suffix: "")
    var clipboard: String?
    input.writeClipboardText = { clipboard = $0 }
    input.readClipboardText = { clipboard }
    input.selectedRange = NSRange(location: 0, length: 1)
    input.copy(nil)
    XCTAssertEqual(clipboard, "@Session \"Auth\"")
    input.setReferences([])
    input.setControlledText("")
    clipboard = token
    input.paste(nil)
    XCTAssertEqual(input.sourceText, token)
    XCTAssertNil(input.textStorage.attribute(.attachment, at: 0, effectiveRange: nil))
  }

  func testPointAtEitherChipEdgeMapsToSourceEdgesInWindowCoordinates() {
    let input = makeInput()
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 400))
    window.addSubview(input)
    input.frame.origin = CGPoint(x: 30, y: 40)
    input.layoutIfNeeded()
    input.layoutManager.ensureLayout(for: input.textContainer)
    let glyphs = input.layoutManager.glyphRange(forCharacterRange: NSRange(location: 3, length: 1), actualCharacterRange: nil)
    var chip = input.layoutManager.boundingRect(forGlyphRange: glyphs, in: input.textContainer)
    chip.origin.x += input.textContainerInset.left
    chip.origin.y += input.textContainerInset.top
    let left = input.convert(CGPoint(x: chip.minX + 1, y: chip.midY), to: window)
    let right = input.convert(CGPoint(x: chip.maxX - 1, y: chip.midY), to: window)
    XCTAssertEqual(input.sourceOffsetAtWindowPoint(x: left.x, y: left.y), 3)
    XCTAssertEqual(input.sourceOffsetAtWindowPoint(x: right.x, y: right.y), 3 + (token as NSString).length)
  }

  func testEachChipHasOneAccessibleActivationAndForeignImagePasteIsRefused() {
    let input = makeInput()
    var activated: String?
    input.onReferencePress = { activated = $0 }
    input.layoutSubviews()
    let chip = input.accessibleReferenceElements.first
    XCTAssertEqual(chip?.accessibilityLabel, "Session, Auth")
    XCTAssertEqual(chip?.accessibilityActivate(), true)
    XCTAssertEqual(activated, "session:auth")
    let before = input.sourceText
    // A rich-only clipboard has no plain text. Clipboard access is the genuine OS boundary.
    input.readClipboardText = { nil }
    input.paste(nil)
    XCTAssertEqual(input.sourceText, before)
  }
}
