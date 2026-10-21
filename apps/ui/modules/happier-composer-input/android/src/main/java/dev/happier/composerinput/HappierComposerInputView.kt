package dev.happier.composerinput

import android.content.Context
import android.view.ViewGroup
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

internal class HappierComposerInputView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onChange by EventDispatcher<Map<String, Any>>()
  private val onSelection by EventDispatcher<Map<String, Any>>()
  private val onKeyPress by EventDispatcher<Map<String, Any>>()
  private val onSubmitEditing by EventDispatcher<Map<String, Any>>()
  private val onFocus by EventDispatcher<Map<String, Any>>()
  private val onBlur by EventDispatcher<Map<String, Any>>()
  private val onContentHeightChange by EventDispatcher<Map<String, Any>>()
  private val onScroll by EventDispatcher<Map<String, Any>>()
  private val onReferencePress by EventDispatcher<Map<String, Any>>()
  private val onDecorationPress by EventDispatcher<Map<String, Any>>()
  private val onAttachmentDrop by EventDispatcher<Map<String, Any>>()
  val editor = ComposerEditText(context)
  private var autoFocus = false
  private var initialScrollY = 0.0
  private var scrollRestoreToken: String? = null
  private var controlledValue: String? = null
  private var mostRecentEventCount = 0
  private var controlledReferences: List<Map<String, Any?>>? = null
  private var controlledDecorations: List<Map<String, Any?>>? = null

  override val shouldUseAndroidLayout = true

  init {
    orientation = VERTICAL
    editor.id = View.generateViewId()
    addView(editor, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    editor.onComposerChange = { text, selection, eventCount -> onChange(mapOf("text" to text, "selection" to selection, "eventCount" to eventCount, "nativeInputTag" to editor.id, "references" to editor.referenceSnapshots()) + caretPayload()) }
    editor.onComposerSelection = { selection -> onSelection(mapOf("selection" to selection, "nativeInputTag" to editor.id) + caretPayload()) }
    editor.onComposerKey = { event -> onKeyPress(event) }
    editor.onComposerSubmit = { event -> onSubmitEditing(event) }
    editor.onComposerReference = { ref -> onReferencePress(mapOf("ref" to ref)) }
    editor.onComposerDecoration = { url -> onDecorationPress(mapOf("url" to url)) }
    editor.onComposerAttachmentDrop = { payload -> onAttachmentDrop(payload) }
    editor.onComposerHeight = { height -> onContentHeightChange(mapOf("height" to height)) }
    editor.onComposerScroll = { y -> onScroll(mapOf("y" to y) + caretPayload()) }
    editor.setOnFocusChangeListener { _, focused -> if (focused) onFocus(mapOf("nativeInputTag" to editor.id) + caretPayload()) else onBlur(emptyMap()) }
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
  }

  private fun caretPayload(): Map<String, Any> {
    val rect = editor.caretRect() ?: return emptyMap()
    return mapOf("caretRect" to mapOf("left" to rect.getValue("x"), "top" to rect.getValue("y"), "height" to rect.getValue("height")))
  }

  fun stageValue(value: String) { controlledValue = value }
  fun stageEventCount(value: Int) { mostRecentEventCount = value }
  fun stageReferences(value: List<Map<String, Any?>>) { controlledReferences = value }
  fun stageDecorations(value: List<Map<String, Any?>>) { controlledDecorations = value }
  fun applyControlledProps() {
    if (controlledValue == null && controlledReferences == null && controlledDecorations == null) return
    editor.setControlledDocument(controlledValue, mostRecentEventCount, controlledReferences, controlledDecorations)
    controlledValue = null
    controlledReferences = null
    controlledDecorations = null
  }

  fun focusEditor() {
    if (editor.requestFocus()) (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT)
  }

  fun blurEditor() {
    editor.clearFocus()
    (context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(editor.windowToken, 0)
  }

  fun setEditable(enabled: Boolean) {
    editor.isFocusable = enabled
    editor.isFocusableInTouchMode = enabled
    editor.isCursorVisible = enabled
    editor.isEnabled = enabled
  }

  fun setAutoFocus(enabled: Boolean) {
    val changed = autoFocus != enabled
    autoFocus = enabled
    if (enabled && changed && isAttachedToWindow) post { focusEditor() }
  }

  fun setReturnKeyType(value: String) {
    val action = when (value) {
      "done" -> EditorInfo.IME_ACTION_DONE
      "go" -> EditorInfo.IME_ACTION_GO
      "next" -> EditorInfo.IME_ACTION_NEXT
      "previous" -> EditorInfo.IME_ACTION_PREVIOUS
      "search" -> EditorInfo.IME_ACTION_SEARCH
      "send" -> EditorInfo.IME_ACTION_SEND
      else -> EditorInfo.IME_ACTION_NONE
    }
    editor.imeOptions = action or EditorInfo.IME_FLAG_NO_EXTRACT_UI
  }

  fun setInitialScrollY(value: Double) {
    initialScrollY = value
  }

  fun setScrollRestoreToken(value: String?) {
    if (scrollRestoreToken == value) return
    scrollRestoreToken = value
    restoreScroll()
  }

  private fun restoreScroll() {
    post { editor.scrollTo(0, (initialScrollY * resources.displayMetrics.density).toInt()) }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    restoreScroll()
    if (autoFocus) post { focusEditor() }
  }
}
