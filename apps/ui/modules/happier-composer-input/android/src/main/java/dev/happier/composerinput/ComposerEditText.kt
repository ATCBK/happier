package dev.happier.composerinput

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputFilter
import android.text.InputType
import android.text.Selection
import android.text.Spanned
import android.text.TextWatcher
import android.text.TextPaint
import android.text.style.ForegroundColorSpan
import android.text.style.BackgroundColorSpan
import android.text.style.TypefaceSpan
import android.text.style.MetricAffectingSpan
import android.text.style.UnderlineSpan
import android.util.TypedValue
import android.view.DragEvent
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityNodeProvider
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.view.inputmethod.InputContentInfo
import androidx.appcompat.widget.AppCompatEditText
import androidx.appcompat.widget.PopupMenu
import androidx.core.view.ViewCompat
import com.facebook.react.common.assets.ReactFontManager
import java.lang.Character
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Sole Android editing owner: source text, spans, selection, composition and clipboard. */
internal class ComposerEditText(context: Context) : AppCompatEditText(context) {
  var onComposerChange: ((String, Map<String, Int>, Int) -> Unit)? = null
  var onComposerSelection: ((Map<String, Int>) -> Unit)? = null
  var onComposerKey: ((Map<String, Any>) -> Unit)? = null
  var onComposerSubmit: (() -> Unit)? = null
  var onComposerReference: ((String) -> Unit)? = null
  var onComposerDecoration: ((String) -> Unit)? = null
  var referenceMenuLabels: Map<String, String> = emptyMap()
  private var lastTouchX = 0f
  private var lastTouchY = 0f
  private var longPressHandled = false
  var onComposerHeight: ((Float) -> Unit)? = null
  var onComposerScroll: ((Float) -> Unit)? = null
  var submitBehavior = "newline"
  var composerAccessibilityHint: String? = null
  var nativeEventCount = 0
    private set
  private data class ControlledDocument(val value: String?, val eventCount: Int, val references: List<Map<String, Any?>>?, val decorations: List<Map<String, Any?>>?)
  private var pendingDocument: ControlledDocument? = null
  private var applyingControlled = false
  private var snappingSelection = false
  private var ready = false
  private var pendingValue: String? = null
  private var pendingSelection: Map<String, Int>? = null
  private var pendingReferences: List<Map<String, Any?>>? = null
  private var pendingDecorations: List<Map<String, Any?>>? = null
  private var decorationSpecs = emptyList<Map<String, Any?>>()
  private var decorationSpans = mutableListOf<Any>()
  private var theme = emptyMap<String, Any?>()
  private var typography = emptyMap<String, Any?>()
  private var dropOffset: Int? = null
  private var lastContentHeight = -1
  private var accessibilityFocus = View.NO_ID

  init {
    background = null
    gravity = android.view.Gravity.TOP or android.view.Gravity.START
    setSingleLine(false)
    inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    setPadding(0, 0, 0, 0)
    // Consume refused content: returning it would invoke AppCompat's default text insertion.
    // AndroidX requires a concrete MIME family; InputConnection advertises no rich content.
    ViewCompat.setOnReceiveContentListener(this, arrayOf("image/*")) { _, _ -> null }
    filters = arrayOf(InputFilter { _, _, _, dest, dstart, dend ->
      if (applyingControlled) null else {
        val partial = dest.getSpans(0, dest.length, ComposerChipSpan::class.java).any { span ->
          val left = dest.getSpanStart(span)
          val right = dest.getSpanEnd(span)
          (dstart > left && dstart < right) || (dend > left && dend < right)
        }
        // Known edit entry points expand first. Refuse an unknown platform edit that splits a chip.
        if (partial) dest.subSequence(dstart, dend) else null
      }
    })
    addTextChangedListener(object : TextWatcher {
      override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
      override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
      override fun afterTextChanged(s: Editable) {
        if (applyingControlled) return
        chips().forEach { span ->
          val start = s.getSpanStart(span)
          val end = s.getSpanEnd(span)
          if (start < 0 || end <= start || s.subSequence(start, end).toString() != span.reference.source) s.removeSpan(span)
        }
        nativeEventCount++
        onComposerChange?.invoke(s.toString(), sourceSelection(), nativeEventCount)
        requestLayout()
        invalidate()
      }
    })
    setOnEditorActionListener { _, actionId, event ->
      if (submitBehavior != "newline" && !isComposing() && event?.isShiftPressed != true &&
        (actionId != EditorInfo.IME_NULL || event?.keyCode == KeyEvent.KEYCODE_ENTER)) {
        submit()
        true
      } else false
    }
    ready = true
  }

  private val density get() = resources.displayMetrics.density
  private val fontScale get() = resources.configuration.fontScale
  private fun dimension(map: Map<String, Any?>, key: String, fallback: Float): Float = (map[key] as? Number)?.toFloat() ?: fallback
  private fun ink(key: String, fallback: Int = currentTextColor): Int {
    return when (val value = theme[key]) {
      is Number -> value.toInt()
      is String -> {
        if (value.trim().equals("transparent", ignoreCase = true)) return Color.TRANSPARENT
        val components = Regex("rgba?\\(([^)]+)\\)").matchEntire(value.trim())?.groupValues?.get(1)?.split(',')?.map { it.trim().toFloatOrNull() }
        if (components != null && components.size in 3..4 && components.all { it != null }) {
          val rgb = components.take(3).map { it!! }
          val alpha = components.getOrNull(3) ?: 1f
          if (rgb.all { it.isFinite() && it in 0f..255f } && alpha.isFinite() && alpha in 0f..1f)
            Color.argb((alpha * 255).roundToInt(), rgb[0].roundToInt(), rgb[1].roundToInt(), rgb[2].roundToInt()) else fallback
        } else runCatching { Color.parseColor(value) }.getOrDefault(fallback)
      }
      else -> fallback
    }
  }

  private fun chipStyle() = ComposerChipStyle(
    ink("chipForeground"), ink("chipBackground", Color.TRANSPARENT), ink("warning"), ink("muted"), ink("selection", highlightColor),
    dimension(typography, "chipHeight", textSize / density) * density * fontScale,
    dimension(typography, "chipRadius", 0f) * density * fontScale,
    dimension(typography, "chipMaxLabelWidth", width.toFloat() / density) * density * fontScale,
    (typography["chipFontFamily"] as? String)?.let { ReactFontManager.getInstance().getTypeface(it, Typeface.NORMAL, context.assets) } ?: typeface,
    dimension(typography, "chipPaddingLeft", 0f) * density * fontScale,
    dimension(typography, "chipPaddingRight", 0f) * density * fontScale,
    dimension(typography, "chipGlyphSize", 0f) * density * fontScale,
    dimension(typography, "chipGap", 0f) * density * fontScale,
    ink("chipGlyphForeground", ink("chipForeground")),
  )

  fun setThemeTokens(value: Map<String, Any?>) {
    theme = value
    setTextColor(ink("text"))
    setHintTextColor(ink("placeholder", currentHintTextColor))
    highlightColor = ink("selection", highlightColor)
    applyDecorations()
    requestLayout()
    invalidate()
  }

  fun setTypographyTokens(value: Map<String, Any?>) {
    typography = value
    (value["fontSize"] as? Number)?.let { setTextSize(TypedValue.COMPLEX_UNIT_SP, it.toFloat()) }
    val family = value["fontFamily"] as? String
    val weight = (value["fontWeight"] as? Number)?.toInt() ?: (value["fontWeight"] as? String)?.toIntOrNull() ?: 400
    typeface = if (family != null) ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, weight, context.assets)
      else if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.DEFAULT, weight, false)
      else Typeface.create(Typeface.DEFAULT, if (weight >= 600) Typeface.BOLD else Typeface.NORMAL)
    (value["lineHeight"] as? Number)?.let { setLineSpacing(max(0f, it.toFloat() * density * fontScale - paint.fontSpacing), 1f) }
    applyDecorations()
    requestLayout()
    invalidate()
  }

  fun setPaddingTokens(value: Map<String, Any?>) {
    setPadding((dimension(value, "left", 0f) * density).toInt(), (dimension(value, "top", 0f) * density).toInt(),
      (dimension(value, "right", 0f) * density).toInt(), (dimension(value, "bottom", 0f) * density).toInt())
  }

  fun setAutocorrect(enabled: Boolean) {
    inputType = if (enabled) inputType and InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS.inv() or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
      else inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT.inv() or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
  }

  fun setAutocapitalize(mode: String) {
    val caps = InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_CAP_WORDS or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
    inputType = inputType and caps.inv() or when (mode) {
      "characters" -> InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
      "words" -> InputType.TYPE_TEXT_FLAG_CAP_WORDS
      "sentences" -> InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      else -> 0
    }
  }

  fun setControlledValue(value: String, selection: Map<String, Int>? = null) {
    if (isComposing()) {
      if (text.toString() == value && selection == null) return
      pendingValue = value
      pendingSelection = selection
      return
    }
    if (text.toString() != value) {
      val previous = sourceSelection()
      val before = text.toString()
      var prefix = 0
      while (prefix < min(before.length, value.length) && before[prefix] == value[prefix]) prefix++
      prefix = snap(prefix, -1)
      var suffix = 0
      while (suffix < min(before.length - prefix, value.length - prefix) && before[before.length - suffix - 1] == value[value.length - suffix - 1]) suffix++
      val oldEnd = snap(before.length - suffix, 1)
      val newEnd = value.length - (before.length - oldEnd)
      applyingControlled = true
      try {
        text!!.replace(prefix, oldEnd, value, prefix, newEnd)
        setSourceSelection(selection ?: previous)
      } finally { applyingControlled = false }
    } else if (selection != null) setSourceSelection(selection)
  }

  /** Match the source value and ranges to the acknowledged native edit, as one prop batch. */
  fun setControlledDocument(value: String?, eventCount: Int, references: List<Map<String, Any?>>?, decorations: List<Map<String, Any?>>?) {
    if (eventCount < nativeEventCount) return
    if (isComposing()) {
      val previous = pendingDocument?.takeIf { it.eventCount == eventCount }
      pendingDocument = ControlledDocument(value ?: previous?.value, eventCount, references ?: previous?.references, decorations ?: previous?.decorations)
      return
    }
    if (value != null) setControlledValue(value)
    if (references != null) setReferences(references)
    if (decorations != null) setDecorations(decorations)
  }

  fun setReferences(values: List<Map<String, Any?>>) {
    if (isComposing()) { pendingReferences = values; return }
    val editable = text ?: return
    chips().forEach(editable::removeSpan)
    var previousEnd = 0
    values.sortedBy { (it["start"] as? Number)?.toInt() ?: -1 }.forEach { value ->
      val start = (value["start"] as? Number)?.toInt() ?: return@forEach
      val end = (value["end"] as? Number)?.toInt() ?: return@forEach
      val ref = value["ref"] as? String ?: return@forEach
      val label = value["label"] as? String ?: return@forEach
      if (start < previousEnd || start < 0 || end <= start || end > editable.length || splitsSurrogate(start) || splitsSurrogate(end)) return@forEach
      val reference = ComposerReference(ref, label, value["kind"] as? String ?: "", value["state"] as? String ?: "ready",
        value["glyph"] as? String, value["accessibilityLabel"] as? String ?: label, value["marker"] as? String ?: label,
        editable.subSequence(start, end).toString())
      lateinit var span: ComposerChipSpan
      span = ComposerChipSpan(reference, ::chipStyle) { selectionStart == editable.getSpanStart(span) && selectionEnd == editable.getSpanEnd(span) }
      editable.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
      previousEnd = end
    }
    setSourceSelection(sourceSelection())
    requestLayout()
    invalidate()
    sendAccessibilityEvent(AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
  }

  fun setDecorations(values: List<Map<String, Any?>>) {
    if (isComposing()) { pendingDecorations = values; return }
    decorationSpecs = values
    applyDecorations()
  }

  private fun applyDecorations() {
    val editable = text ?: return
    decorationSpans.forEach(editable::removeSpan)
    decorationSpans.clear()
    decorationSpecs.forEach { value ->
      val start = (value["start"] as? Number)?.toInt() ?: return@forEach
      val end = (value["end"] as? Number)?.toInt() ?: return@forEach
      if (start < 0 || end <= start || end > length()) return@forEach
      fun add(span: Any) { editable.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE); decorationSpans.add(span) }
      when (val treatment = value["treatment"]) {
        "muted" -> add(ForegroundColorSpan(ink("muted")))
        "warning" -> add(ForegroundColorSpan(ink("warning")))
        "success" -> add(ForegroundColorSpan(ink("success")))
        "highlight" -> add(BackgroundColorSpan(ink("selection", highlightColor)))
        "code", "monospace" -> {
          val family = typography["monoFontFamily"] as? String
          if (family == null) add(TypefaceSpan("monospace")) else {
            val face = ReactFontManager.getInstance().getTypeface(family, Typeface.NORMAL, context.assets)
            add(object : MetricAffectingSpan() {
              override fun updateDrawState(paint: TextPaint) { paint.typeface = face }
              override fun updateMeasureState(paint: TextPaint) { paint.typeface = face }
            })
          }
        }
        "underline" -> add(UnderlineSpan())
        is Map<*, *> -> if (treatment["kind"] == "link") { add(ForegroundColorSpan(ink("link"))); add(UnderlineSpan()) }
      }
    }
    invalidate()
  }

  private fun chips(): Array<ComposerChipSpan> = text?.getSpans(0, length(), ComposerChipSpan::class.java) ?: emptyArray()
  private fun splitsSurrogate(offset: Int): Boolean = offset > 0 && offset < length() && Character.isHighSurrogate(text!![offset - 1]) && Character.isLowSurrogate(text!![offset])

  private fun snap(offset: Int, direction: Int = 0): Int {
    val editable = text ?: return 0
    var position = offset.coerceIn(0, editable.length)
    chips().firstOrNull { position > editable.getSpanStart(it) && position < editable.getSpanEnd(it) }?.let {
      val start = editable.getSpanStart(it)
      val end = editable.getSpanEnd(it)
      position = if (direction < 0 || (direction == 0 && position - start <= end - position)) start else end
    }
    if (splitsSurrogate(position)) position += if (direction < 0) -1 else 1
    return position
  }

  fun sourceSelection(): Map<String, Int> {
    val start = max(0, selectionStart)
    val end = max(0, selectionEnd)
    return if (start == end) mapOf("start" to snap(start), "end" to snap(end))
      else mapOf("start" to snap(min(start, end), -1), "end" to snap(max(start, end), 1))
  }

  fun referenceSnapshots(): List<Map<String, Any>> = chips().sortedBy { text!!.getSpanStart(it) }.map { span ->
    mapOf("ref" to span.reference.ref, "token" to span.reference.source,
      "start" to text!!.getSpanStart(span), "end" to text!!.getSpanEnd(span))
  }

  fun setSourceSelection(value: Map<String, Int>) {
    val editable = text ?: return
    val start = value["start"] ?: 0
    val end = value["end"] ?: start
    val collapsed = start == end
    Selection.setSelection(editable, snap(min(start, end), if (collapsed) 0 else -1), snap(max(start, end), if (collapsed) 0 else 1))
  }

  override fun onSelectionChanged(selStart: Int, selEnd: Int) {
    super.onSelectionChanged(selStart, selEnd)
    if (!ready || snappingSelection || selStart < 0 || selEnd < 0) return
    val selection = sourceSelection()
    if (selStart != selection["start"] || selEnd != selection["end"]) {
      snappingSelection = true
      try { text?.let { Selection.setSelection(it, selection.getValue("start"), selection.getValue("end")) } } finally { snappingSelection = false }
    }
    if (!applyingControlled) onComposerSelection?.invoke(selection)
    invalidate()
  }

  fun isComposing(): Boolean = text?.let { BaseInputConnection.getComposingSpanStart(it) >= 0 } ?: false

  private fun flushControlledUpdates() {
    if (isComposing()) return
    val document = pendingDocument
    val value = pendingValue
    val selection = pendingSelection
    val references = pendingReferences
    val decorations = pendingDecorations
    pendingDocument = null; pendingValue = null; pendingSelection = null; pendingReferences = null; pendingDecorations = null
    if (document != null) setControlledDocument(document.value, document.eventCount, document.references, document.decorations)
    if (value != null) setControlledValue(value, selection)
    if (references != null) setReferences(references)
    if (decorations != null) setDecorations(decorations)
  }

  private fun expandedRange(start: Int, end: Int): Pair<Int, Int> = snap(start, -1) to snap(end, 1)

  private fun normalizeReplacement() {
    val editable = text ?: return
    val composingStart = BaseInputConnection.getComposingSpanStart(editable)
    val composingEnd = BaseInputConnection.getComposingSpanEnd(editable)
    val start = if (composingStart >= 0) composingStart else max(0, min(selectionStart, selectionEnd))
    val end = if (composingEnd >= 0) composingEnd else max(0, max(selectionStart, selectionEnd))
    val range = if (start == end) snap(start) to snap(end) else expandedRange(start, end)
    if (range.first != start || range.second != end) {
      BaseInputConnection.removeComposingSpans(editable)
      Selection.setSelection(editable, range.first, range.second)
    }
  }

  private fun deleteSurrounding(before: Int, after: Int, codePoints: Boolean): Boolean {
    if (!isEnabled || !isFocusable) return false
    val editable = text ?: return false
    val selection = sourceSelection()
    val start = selection.getValue("start")
    val end = selection.getValue("end")
    if (before < 0 || after < 0) return false
    if (before == 0 && after == 0) return true
    if (start == end && before == 1 && after == 0) {
      chips().firstOrNull { editable.getSpanEnd(it) == start }?.let {
        setSourceSelection(mapOf("start" to editable.getSpanStart(it), "end" to start))
        return true
      }
    }
    fun shift(offset: Int, amount: Int): Int = if (codePoints) {
      val available = Character.codePointCount(editable, if (amount < 0) 0 else offset, if (amount < 0) offset else editable.length)
      Character.offsetByCodePoints(editable, offset, if (amount < 0) -min(-amount, available) else min(amount, available))
    } else (offset + amount).coerceIn(0, editable.length)
    val range = if (start != end) expandedRange(start, end) else expandedRange(shift(start, -before), shift(end, after))
    if (range.first == range.second) return false
    editable.delete(range.first, range.second)
    setSelection(range.first)
    return true
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val connection = super.onCreateInputConnection(outAttrs) ?: return null
    outAttrs.contentMimeTypes = emptyArray()
    return object : InputConnectionWrapper(connection, false) {
      override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
        if (!isComposing() && (beforeLength > 0 || afterLength > 0)) emitPlainKey(if (beforeLength > 0) "Backspace" else "Delete")
        return deleteSurrounding(beforeLength, afterLength, false)
      }
      override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean {
        if (!isComposing() && (beforeLength > 0 || afterLength > 0)) emitPlainKey(if (beforeLength > 0) "Backspace" else "Delete")
        return deleteSurrounding(beforeLength, afterLength, true)
      }
      override fun commitText(value: CharSequence?, newCursorPosition: Int): Boolean {
        if (!isComposing() && value?.toString() == "\n" && submitBehavior != "newline") {
          emitPlainKey("Enter")
          submit()
          return true
        }
        if (!isComposing() && value != null && Character.codePointCount(value, 0, value.length) == 1) emitPlainKey(value.toString())
        normalizeReplacement()
        val result = super.commitText(value?.toString() ?: "", newCursorPosition)
        flushControlledUpdates()
        return result
      }
      override fun setComposingText(value: CharSequence?, newCursorPosition: Int): Boolean {
        normalizeReplacement()
        return super.setComposingText(value?.toString() ?: "", newCursorPosition)
      }
      override fun setComposingRegion(start: Int, end: Int): Boolean {
        val left = min(start, end).coerceIn(0, length())
        val right = max(start, end).coerceIn(0, length())
        if (chips().any { text!!.getSpanStart(it) < right && text!!.getSpanEnd(it) > left }) return false
        return super.setComposingRegion(left, right)
      }
      override fun finishComposingText(): Boolean {
        val result = super.finishComposingText()
        flushControlledUpdates()
        return result
      }
      override fun setSelection(start: Int, end: Int): Boolean {
        setSourceSelection(mapOf("start" to start, "end" to end))
        return true
      }
      override fun commitContent(inputContentInfo: InputContentInfo, flags: Int, opts: Bundle?): Boolean = false
      override fun performPrivateCommand(action: String?, data: Bundle?): Boolean {
        if (action?.contains("COMMIT_CONTENT") == true) return false
        return super.performPrivateCommand(action, data)
      }
      override fun performEditorAction(editorAction: Int): Boolean {
        if (submitBehavior != "newline" && !isComposing()) { submit(); return true }
        return super.performEditorAction(editorAction)
      }
    }
  }

  private fun submit() {
    onComposerSubmit?.invoke()
    if (submitBehavior == "blurAndSubmit") clearFocus()
  }

  private fun emitPlainKey(key: String) {
    onComposerKey?.invoke(mapOf("key" to key, "shiftKey" to false, "ctrlKey" to false, "altKey" to false, "metaKey" to false))
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    val key = when (keyCode) {
      KeyEvent.KEYCODE_DEL -> "Backspace"
      KeyEvent.KEYCODE_FORWARD_DEL -> "Delete"
      KeyEvent.KEYCODE_ENTER -> "Enter"
      KeyEvent.KEYCODE_DPAD_LEFT -> "ArrowLeft"
      KeyEvent.KEYCODE_DPAD_RIGHT -> "ArrowRight"
      KeyEvent.KEYCODE_DPAD_UP -> "ArrowUp"
      KeyEvent.KEYCODE_DPAD_DOWN -> "ArrowDown"
      KeyEvent.KEYCODE_ESCAPE -> "Escape"
      KeyEvent.KEYCODE_TAB -> "Tab"
      else -> if (event.unicodeChar != 0) String(Character.toChars(event.unicodeChar)) else KeyEvent.keyCodeToString(keyCode)
    }
    if (!isComposing()) onComposerKey?.invoke(mapOf("key" to key, "shiftKey" to event.isShiftPressed, "ctrlKey" to event.isCtrlPressed, "altKey" to event.isAltPressed, "metaKey" to event.isMetaPressed))
    if (!isComposing()) {
      if (keyCode == KeyEvent.KEYCODE_DEL && !event.isCtrlPressed && !event.isAltPressed) return deleteSurrounding(1, 0, false)
      if (keyCode == KeyEvent.KEYCODE_FORWARD_DEL && !event.isCtrlPressed && !event.isAltPressed) return deleteSurrounding(0, 1, false)
      if (keyCode == KeyEvent.KEYCODE_ENTER && submitBehavior != "newline" && !event.isShiftPressed) { submit(); return true }
      if (!event.isShiftPressed && !event.isCtrlPressed && !event.isAltPressed && selectionStart == selectionEnd && keyCode in listOf(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT)) {
        val span = chips().firstOrNull { if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) text!!.getSpanEnd(it) == selectionStart else text!!.getSpanStart(it) == selectionStart }
        if (span != null) { setSelection(if (keyCode == KeyEvent.KEYCODE_DPAD_LEFT) text!!.getSpanStart(span) else text!!.getSpanEnd(span)); return true }
      }
    }
    return super.onKeyDown(keyCode, event)
  }

  private fun readableSelection(start: Int, end: Int): String {
    val editable = text ?: return ""
    val result = StringBuilder()
    var offset = start
    chips().sortedBy { editable.getSpanStart(it) }.forEach { span ->
      val left = editable.getSpanStart(span)
      val right = editable.getSpanEnd(span)
      if (left >= start && right <= end) {
        result.append(editable.subSequence(offset, left)).append(span.reference.marker)
        offset = right
      }
    }
    return result.append(editable.subSequence(offset, end)).toString()
  }

  override fun onTextContextMenuItem(id: Int): Boolean {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val selection = sourceSelection()
    val start = selection.getValue("start")
    val end = selection.getValue("end")
    if (id == android.R.id.copy || id == android.R.id.cut) {
      if (start == end) return false
      clipboard.setPrimaryClip(ClipData.newPlainText("", readableSelection(start, end)))
      if (id == android.R.id.cut && isEnabled && isFocusable) { text!!.delete(start, end); setSelection(start) }
      return true
    }
    if (id == android.R.id.paste || id == android.R.id.pasteAsPlainText) {
      if (!isEnabled || !isFocusable) return false
      val clip = clipboard.primaryClip ?: return false
      // URI/image clipboard entries are refused; never coerce them into textual URI payloads.
      val plain = (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).text?.toString() }.joinToString("\n")
      if (plain.isEmpty()) return false
      text!!.replace(start, end, plain)
      setSelection(start + plain.length)
      return true
    }
    return super.onTextContextMenuItem(id)
  }

  override fun onDragEvent(event: DragEvent): Boolean = false

  fun offsetAtWindowPoint(x: Float, y: Float): Int? {
    if (!x.isFinite() || !y.isFinite() || width <= 0 || height <= 0) return null
    val location = IntArray(2)
    getLocationInWindow(location)
    val localX = x * density - location[0]
    val localY = y * density - location[1]
    if (localX < 0 || localY < 0 || localX > width || localY > height) return null
    val layout = layout ?: return null
    val line = layout.getLineForVertical((localY - totalPaddingTop + scrollY).toInt())
    val horizontal = localX - totalPaddingLeft + scrollX
    val offset = layout.getOffsetForHorizontal(line, horizontal)
    val span = chips().firstOrNull { chipBounds(it).contains(localX.toInt(), localY.toInt()) }
    if (span != null) {
      val start = text!!.getSpanStart(span)
      val end = text!!.getSpanEnd(span)
      val bounds = chipBounds(span)
      val rtl = layout.isRtlCharAt(start)
      val first = if (rtl) bounds.right else bounds.left
      val last = if (rtl) bounds.left else bounds.right
      return if (abs(localX - first) <= abs(localX - last)) start else end
    }
    return snap(offset)
  }

  fun setDropCaret(offset: Int?) { dropOffset = offset?.let { snap(it) }; invalidate() }

  fun caretRect(): Map<String, Float>? {
    val layout = layout ?: return null
    val offset = snap(max(0, selectionEnd))
    val line = layout.getLineForOffset(offset)
    val location = IntArray(2)
    getLocationInWindow(location)
    return mapOf("x" to (location[0] + totalPaddingLeft + layout.getPrimaryHorizontal(offset) - scrollX) / density,
      "y" to (location[1] + totalPaddingTop + layout.getLineTop(line) - scrollY) / density,
      "width" to 1f, "height" to (layout.getLineBottom(line) - layout.getLineTop(line)) / density)
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val offset = dropOffset ?: return
    val layout = layout ?: return
    val line = layout.getLineForOffset(offset.coerceIn(0, length()))
    val x = layout.getPrimaryHorizontal(offset) + totalPaddingLeft - scrollX
    val paint = Paint().apply { color = ink("selection"); strokeWidth = density }
    canvas.drawLine(x, (layout.getLineTop(line) + totalPaddingTop - scrollY).toFloat(), x, (layout.getLineBottom(line) + totalPaddingTop - scrollY).toFloat(), paint)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    reportContentHeight()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    if (ready) setTypographyTokens(typography)
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    reportContentHeight()
  }

  private fun reportContentHeight() {
    val height = (layout?.height ?: 0) + compoundPaddingTop + compoundPaddingBottom
    if (height != lastContentHeight) { lastContentHeight = height; onComposerHeight?.invoke(height / density) }
  }

  override fun onScrollChanged(l: Int, t: Int, oldl: Int, oldt: Int) {
    super.onScrollChanged(l, t, oldl, oldt)
    if (ready) onComposerScroll?.invoke(t / density)
  }

  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (event.action == MotionEvent.ACTION_DOWN) { lastTouchX = event.x; lastTouchY = event.y; longPressHandled = false }
    if (event.action == MotionEvent.ACTION_UP && !longPressHandled && !isComposing()) {
      val span = chipAtLocalPoint(event.x, event.y)
      if (span != null) onComposerReference?.invoke(span.reference.ref)
    }
    return super.onTouchEvent(event)
  }

  override fun performLongClick(): Boolean {
    if (isComposing()) return super.performLongClick()
    val openLabel = referenceMenuLabels["open"] ?: return super.performLongClick()
    val span = chipAtLocalPoint(lastTouchX, lastTouchY)
    val offset = getOffsetForPosition(lastTouchX, lastTouchY)
    val decoration = decorationSpecs.firstOrNull { entry ->
      val start = (entry["start"] as? Number)?.toInt() ?: return@firstOrNull false
      val end = (entry["end"] as? Number)?.toInt() ?: return@firstOrNull false
      start <= offset && offset < end && (entry["treatment"] as? Map<*, *>)?.get("kind") == "link"
    }
    val url = (decoration?.get("treatment") as? Map<*, *>)?.get("url") as? String
    if (span == null && url == null) return super.performLongClick()
    longPressHandled = true
    PopupMenu(context, this).apply {
      menu.add(openLabel).setOnMenuItemClickListener {
        if (span != null) onComposerReference?.invoke(span.reference.ref) else if (url != null) onComposerDecoration?.invoke(url)
        true
      }
      val removeLabel = referenceMenuLabels["remove"]
      if (span != null && removeLabel != null && isEnabled && isFocusable) {
        menu.add(removeLabel).setOnMenuItemClickListener {
          val editable = text
          if (editable != null) {
            val start = editable.getSpanStart(span)
            val end = editable.getSpanEnd(span)
            if (start >= 0 && end > start) { editable.delete(start, end); setSelection(start) }
          }
          true
        }
      }
      show()
    }
    return true
  }

  private fun chipBounds(span: ComposerChipSpan): Rect {
    val layout = layout ?: return Rect()
    val start = text!!.getSpanStart(span)
    val end = text!!.getSpanEnd(span)
    if (start < 0 || end < 0) return Rect()
    val line = layout.getLineForOffset(start)
    val a = layout.getPrimaryHorizontal(start)
    val spanWidth = span.getSize(paint, text!!, start, end, null)
    val b = a + if (layout.isRtlCharAt(start)) -spanWidth else spanWidth
    return Rect((min(a, b) + totalPaddingLeft - scrollX).toInt(), layout.getLineTop(line) + totalPaddingTop - scrollY,
      (max(a, b) + totalPaddingLeft - scrollX).toInt(), layout.getLineBottom(line) + totalPaddingTop - scrollY)
  }

  private fun chipAtLocalPoint(x: Float, y: Float): ComposerChipSpan? = chips().firstOrNull { chipBounds(it).contains(x.toInt(), y.toInt()) }

  private val chipAccessibility = object : AccessibilityNodeProvider() {
    override fun createAccessibilityNodeInfo(virtualViewId: Int): AccessibilityNodeInfo? {
      if (virtualViewId == View.NO_ID) return AccessibilityNodeInfo.obtain(this@ComposerEditText).also { node ->
        onInitializeAccessibilityNodeInfo(node)
        chips().indices.forEach { node.addChild(this@ComposerEditText, it) }
      }
      val span = chips().getOrNull(virtualViewId) ?: return null
      return AccessibilityNodeInfo.obtain().apply {
        setSource(this@ComposerEditText, virtualViewId)
        setParent(this@ComposerEditText)
        packageName = context.packageName
        className = "android.widget.Button"
        text = span.reference.accessibilityLabel
        contentDescription = span.reference.accessibilityLabel
        isEnabled = this@ComposerEditText.isEnabled
        isClickable = true
        isFocusable = true
        isVisibleToUser = isShown
        val bounds = chipBounds(span)
        setBoundsInParent(bounds)
        val location = IntArray(2)
        getLocationOnScreen(location)
        bounds.offset(location[0], location[1])
        setBoundsInScreen(bounds)
        isAccessibilityFocused = accessibilityFocus == virtualViewId
        addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
        addAction(if (isAccessibilityFocused) AccessibilityNodeInfo.AccessibilityAction.ACTION_CLEAR_ACCESSIBILITY_FOCUS else AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS)
      }
    }

    override fun performAction(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
      if (virtualViewId == View.NO_ID) return performAccessibilityAction(action, arguments)
      val span = chips().getOrNull(virtualViewId) ?: return false
      return when (action) {
        AccessibilityNodeInfo.ACTION_CLICK -> { onComposerReference?.invoke(span.reference.ref); true }
        AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS -> { accessibilityFocus = virtualViewId; sendChipAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED); true }
        AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS -> { accessibilityFocus = View.NO_ID; sendChipAccessibilityEvent(virtualViewId, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED); true }
        else -> false
      }
    }
  }

  override fun getAccessibilityNodeProvider(): AccessibilityNodeProvider? = if (ready && chips().isNotEmpty()) chipAccessibility else super.getAccessibilityNodeProvider()

  override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    if (ready && Build.VERSION.SDK_INT >= 26) {
      val labels = listOfNotNull(composerAccessibilityHint) + decorationSpecs.mapNotNull { it["label"] as? String }
      if (labels.isNotEmpty()) info.hintText = labels.joinToString(". ")
    }
  }

  private fun sendChipAccessibilityEvent(id: Int, type: Int) {
    val event = AccessibilityEvent.obtain(type)
    event.packageName = context.packageName
    event.className = "android.widget.Button"
    event.setSource(this, id)
    chips().getOrNull(id)?.let { event.text.add(it.reference.accessibilityLabel) }
    parent?.requestSendAccessibilityEvent(this, event)
  }

  override fun dispatchHoverEvent(event: MotionEvent): Boolean {
    val span = chipAtLocalPoint(event.x, event.y)
    if (span != null && event.action in listOf(MotionEvent.ACTION_HOVER_ENTER, MotionEvent.ACTION_HOVER_MOVE)) {
      sendChipAccessibilityEvent(chips().indexOf(span), AccessibilityEvent.TYPE_VIEW_HOVER_ENTER)
      return true
    }
    return super.dispatchHoverEvent(event)
  }
}
