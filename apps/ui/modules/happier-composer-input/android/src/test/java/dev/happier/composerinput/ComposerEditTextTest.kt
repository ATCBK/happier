package dev.happier.composerinput

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Color
import android.view.ContextThemeWrapper
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.BaseInputConnection
import androidx.core.view.ContentInfoCompat
import androidx.core.view.ViewCompat
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
class ComposerEditTextTest {
  private val token = "[Auth](happier-ref:session:auth)"
  private val prefix = "😀 a "

  private fun editor(): ComposerEditText {
    val context = ContextThemeWrapper(RuntimeEnvironment.getApplication(), androidx.appcompat.R.style.Theme_AppCompat)
    return ComposerEditText(context).apply {
      layoutParams = ViewGroup.LayoutParams(600, ViewGroup.LayoutParams.WRAP_CONTENT)
      setTypographyTokens(mapOf("fontSize" to 14, "lineHeight" to 22, "chipHeight" to 20, "chipRadius" to 6, "chipMaxLabelWidth" to 190))
      setControlledValue(prefix + token + " z")
      setReferences(listOf(mapOf("start" to prefix.length, "end" to prefix.length + token.length,
        "ref" to "session:auth", "label" to "Auth", "kind" to "session", "state" to "ready",
        "marker" to "@Session \"Auth\"", "accessibilityLabel" to "Session, Auth")))
      measure(View.MeasureSpec.makeMeasureSpec(600, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.AT_MOST))
      layout(0, 0, 600, measuredHeight)
    }
  }

  @Test fun hardwareBackspaceSelectsThenDeletesOneWholeChip() {
    val editor = editor()
    editor.setSelection(prefix.length + token.length)
    editor.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
    assertEquals(prefix.length, editor.selectionStart)
    assertEquals(prefix.length + token.length, editor.selectionEnd)
    assertEquals(prefix + token + " z", editor.text.toString())
    editor.onKeyDown(KeyEvent.KEYCODE_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL))
    assertEquals(prefix + " z", editor.text.toString())
    assertTrue(editor.referenceSnapshots().isEmpty())
  }

  @Test fun softwareKeyboardDeleteAndCodePointDeleteRespectTheSameTwoPressContract() {
    for (codePoints in listOf(false, true)) {
      val editor = editor()
      editor.setSelection(prefix.length + token.length)
      val connection = editor.onCreateInputConnection(EditorInfo())!!
      if (codePoints) connection.deleteSurroundingTextInCodePoints(1, 0) else connection.deleteSurroundingText(1, 0)
      assertEquals(token, editor.text!!.subSequence(editor.selectionStart, editor.selectionEnd).toString())
      if (codePoints) connection.deleteSurroundingTextInCodePoints(1, 0) else connection.deleteSurroundingText(1, 0)
      assertEquals(prefix + " z", editor.text.toString())
    }
  }

  @Test fun forwardDeleteAndCommitOverASelectedChipAreAtomic() {
    val forward = editor()
    forward.setSelection(prefix.length)
    forward.onKeyDown(KeyEvent.KEYCODE_FORWARD_DEL, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_FORWARD_DEL))
    assertEquals(prefix + " z", forward.text.toString())
    val replacement = editor()
    replacement.setSelection(prefix.length + 2, prefix.length + token.length - 2)
    replacement.onCreateInputConnection(EditorInfo())!!.commitText("替", 1)
    assertEquals(prefix + "替 z", replacement.text.toString())
  }

  @Test fun selectionAndArrowsUseUtf16SourceEdgesIncludingEmoji() {
    val editor = editor()
    editor.setSelection(prefix.length + 2)
    assertEquals(prefix.length, editor.selectionStart)
    editor.onKeyDown(KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_RIGHT))
    assertEquals(prefix.length + token.length, editor.selectionStart)
    editor.onKeyDown(KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DPAD_LEFT))
    assertEquals(prefix.length, editor.selectionStart)
  }

  @Test fun compositionDoesNotSplitChipsAndDefersControlledChangesUntilFinish() {
    val editor = editor()
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.setComposingRegion(prefix.length + 1, prefix.length + token.length - 1)
    assertEquals(-1, BaseInputConnection.getComposingSpanStart(editor.text!!))
    editor.setSelection(editor.length())
    connection.setComposingText("に", 1)
    val composing = editor.text.toString()
    editor.setControlledValue("controlled")
    assertEquals(composing, editor.text.toString())
    connection.finishComposingText()
    assertEquals("controlled", editor.text.toString())
  }

  @Test fun pointMappingUsesWindowCoordinatesAndNeverReturnsChipInterior() {
    val editor = editor()
    val layout = requireNotNull(editor.layout)
    val start = prefix.length
    val end = start + token.length
    val location = IntArray(2)
    editor.getLocationInWindow(location)
    val left = layout.getPrimaryHorizontal(start)
    val right = layout.getPrimaryHorizontal(end)
    val y = location[1] + editor.totalPaddingTop + layout.getLineBaseline(0) - editor.scrollY
    val x = location[0] + editor.totalPaddingLeft + (left + right) / 2 - editor.scrollX
    val density = editor.resources.displayMetrics.density
    assertTrue(editor.offsetAtWindowPoint(x / density, y.toFloat() / density) in listOf(start, end))
    assertNull(editor.offsetAtWindowPoint(-100f, -100f))
  }

  @Test fun clipboardProjectsMarkersAndPastesOnlyPlainText() {
    val editor = editor()
    editor.setSelection(prefix.length, prefix.length + token.length)
    assertTrue(editor.onTextContextMenuItem(android.R.id.copy))
    val clipboard = editor.context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    assertEquals("@Session \"Auth\"", clipboard.primaryClip!!.getItemAt(0).text.toString())
    clipboard.setPrimaryClip(ClipData.newHtmlText("text", "literal $token", "<b>literal</b>"))
    editor.onTextContextMenuItem(android.R.id.paste)
    assertEquals(prefix + "literal $token z", editor.text.toString())
    assertEquals(0, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
  }

  @Test fun themeColorsAcceptTheActualRgbaInkTokens() {
    val editor = editor()
    editor.setThemeTokens(mapOf("text" to "rgba(30, 40, 50, 0.5)", "placeholder" to "transparent"))
    assertEquals(Color.argb(128, 30, 40, 50), editor.currentTextColor)
    assertEquals(Color.TRANSPARENT, editor.currentHintTextColor)
  }

  @Test fun receiveContentRefusalDoesNotFallThroughToTextInsertion() {
    val editor = editor()
    val before = editor.text.toString()
    val payload = ContentInfoCompat.Builder(
      ClipData.newPlainText("foreign", "foreign rich-content fallback"), ContentInfoCompat.SOURCE_DRAG_AND_DROP,
    ).build()
    assertNull(ViewCompat.performReceiveContent(editor, payload))
    assertEquals(before, editor.text.toString())
  }

  @Test fun controlledAppendKeepsAnUnchangedChipAndPlainTypingDoesNotCreateOne() {
    val editor = editor()
    editor.setControlledValue(editor.text.toString() + "!")
    assertEquals(1, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
    editor.setSelection(editor.length())
    editor.onCreateInputConnection(EditorInfo())!!.commitText(" $token", 1)
    assertEquals(1, editor.text!!.getSpans(0, editor.length(), ComposerChipSpan::class.java).size)
  }

  @Test fun accessibilityExposesOneLabeledActivatableNodePerChip() {
    val editor = editor()
    var activated: String? = null
    editor.onComposerReference = { activated = it }
    val provider = editor.accessibilityNodeProvider!!
    val node = provider.createAccessibilityNodeInfo(0)!!
    assertEquals("Session, Auth", node.contentDescription)
    assertTrue(provider.performAction(0, android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK, null))
    assertEquals("session:auth", activated)
  }

  @Test fun enterToSendLeavesShiftEnterAndComposingEnterAsInput() {
    val editor = editor()
    editor.submitBehavior = "submit"
    var submissions = 0
    editor.onComposerSubmit = { submissions++ }
    editor.setSelection(editor.length())
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
    assertEquals(1, submissions)
    val shift = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, 0, KeyEvent.META_SHIFT_ON)
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, shift)
    assertEquals(1, submissions)
    editor.onCreateInputConnection(EditorInfo())!!.setComposingText("に", 1)
    editor.onKeyDown(KeyEvent.KEYCODE_ENTER, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER))
    assertEquals(1, submissions)
  }

  @Test fun softwareKeyboardReportsKeysAndNewlineUsesNativeSubmitBehavior() {
    val editor = editor()
    val keys = mutableListOf<String>()
    editor.onComposerKey = { keys.add(it.getValue("key") as String) }
    editor.submitBehavior = "submit"
    var submissions = 0
    editor.onComposerSubmit = { submissions++ }
    editor.setSelection(editor.length())
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.commitText("a", 1)
    assertEquals("a", keys.last())
    connection.deleteSurroundingText(1, 0)
    assertEquals("Backspace", keys.last())
    val before = editor.text.toString()
    connection.commitText("\n", 1)
    assertEquals(1, submissions)
    assertEquals(before, editor.text.toString())
  }

  @Test fun staleControlledEchoCannotReplaceACommittedComposition() {
    val editor = editor()
    editor.setSelection(editor.length())
    val connection = editor.onCreateInputConnection(EditorInfo())!!
    connection.setComposingText("に", 1)
    val intermediate = editor.text.toString()
    val intermediateCount = editor.nativeEventCount
    editor.setControlledDocument(intermediate, intermediateCount, emptyList(), emptyList())
    connection.commitText("日本", 1)
    val committed = editor.text.toString()
    assertTrue(committed.endsWith("日本"))
    assertTrue(editor.nativeEventCount > intermediateCount)
    editor.setControlledDocument(intermediate, intermediateCount, emptyList(), emptyList())
    assertEquals(committed, editor.text.toString())
    editor.setControlledDocument("accepted", editor.nativeEventCount, emptyList(), emptyList())
    assertEquals("accepted", editor.text.toString())
  }
}
