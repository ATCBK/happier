import ExpoModulesCore
import UIKit

final class HappierComposerInputView: ExpoView {
  let input = HappierComposerTextView(frame: .zero)
  let onChange = EventDispatcher()
  let onSelection = EventDispatcher()
  let onKeyPress = EventDispatcher()
  let onSubmitEditing = EventDispatcher()
  let onFocus = EventDispatcher()
  let onBlur = EventDispatcher()
  let onContentHeightChange = EventDispatcher()
  let onScroll = EventDispatcher()
  let onReferencePress = EventDispatcher()
  let onDecorationPress = EventDispatcher()
  let onAttachmentDrop = EventDispatcher()
  var autoFocus = false
  var mostRecentEventCount = 0
  var pendingValue: String?
  var pendingReferences: [[String: Any]]?
  var pendingDecorations: [[String: Any]]?
  private var applyingControlledProps = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isAccessibilityElement = false
    addSubview(input)
    input.onReferenceAccessibilityChange = { [weak self] in
      guard let self else { return }
      self.accessibilityElements = [self.input] + self.input.accessibleReferenceElements
    }
    input.onChange = { [weak self] text, selection in
      guard let self else { return }
      self.onChange(self.withCaret(["text": text, "selection": selection, "eventCount": self.input.eventCount, "references": self.input.referenceSnapshots()]))
    }
    input.onSelection = { [weak self] selection in
      guard let self, !self.applyingControlledProps else { return }
      self.onSelection(self.withCaret(["selection": selection]))
    }
    input.onKeyPress = { [weak self] payload in self?.onKeyPress(payload) }
    input.onSubmitEditing = { [weak self] payload in self?.onSubmitEditing(payload) }
    input.onFocus = { [weak self] in
      guard let self else { return }
      self.onFocus(self.withCaret([:]))
    }
    input.onBlur = { [weak self] in self?.onBlur([:]) }
    input.onContentHeightChange = { [weak self] height in self?.onContentHeightChange(["height": height]) }
    input.onScroll = { [weak self] y in
      guard let self else { return }
      self.onScroll(self.withCaret(["y": y]))
    }
    input.onReferencePress = { [weak self] ref in self?.onReferencePress(["ref": ref]) }
    input.onDecorationPress = { [weak self] url in self?.onDecorationPress(["url": url]) }
    input.onAttachmentDrop = { [weak self] payload in self?.onAttachmentDrop(payload) }
  }

  func applyControlledProps() {
    let value = pendingValue
    let references = pendingReferences
    let decorations = pendingDecorations
    pendingValue = nil; pendingReferences = nil; pendingDecorations = nil
    guard mostRecentEventCount >= input.eventCount else { return }
    applyingControlledProps = true
    input.setControlledDocument(value: value, references: references, eventCount: mostRecentEventCount)
    if let decorations { input.setDecorations(decorations) }
    applyingControlledProps = false
    if value != nil || references != nil { onSelection(withCaret(["selection": input.sourceSelection])) }
  }

  private func withCaret(_ payload: [String: Any]) -> [String: Any] {
    guard let rect = input.sourceCaretRect(), let left = rect["x"], let top = rect["y"], let height = rect["height"] else { return payload }
    var result = payload
    result["caretRect"] = ["left": left, "top": top, "height": height]
    return result
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    input.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil && autoFocus { input.becomeFirstResponder() }
  }
}
