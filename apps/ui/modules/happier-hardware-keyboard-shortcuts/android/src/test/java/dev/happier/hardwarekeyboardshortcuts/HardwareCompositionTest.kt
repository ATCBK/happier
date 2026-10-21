package dev.happier.hardwarekeyboardshortcuts

import android.view.InputDevice
import android.view.KeyEvent
import android.view.inputmethod.BaseInputConnection
import android.widget.EditText
import expo.modules.kotlin.modules.Module
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
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
class HardwareCompositionTest {
  private lateinit var module: HappierHardwareKeyboardShortcutsModule

  @Before fun enableRealBridge() {
    module = HappierHardwareKeyboardShortcutsModule()
    // Only the external Expo→JS delivery is suppressed; native admission and consumption stay real.
    Module::class.java.getDeclaredField("moduleEventEmitter\$delegate").apply { isAccessible = true }.set(module, lazyOf(null))
    fun configure(field: String, value: Any) {
      module.javaClass.getDeclaredField(field).apply { isAccessible = true }.set(module, value)
    }
    configure("hardwareKeyEventsEnabled", true)
    configure("hasHardwareKeyListener", true)
    configure("nativeConsumableEventSignatures", setOf("Enter|shift=false|ctrl=false|meta=false|alt=false", "ArrowUp|shift=false|ctrl=false|meta=false|alt=false"))
    HappierHardwareKeyboardShortcutsBridge.setModule(module)
    HappierHardwareKeyboardShortcutsBridge.setEnabled(true)
  }

  @After fun disableBridge() { HappierHardwareKeyboardShortcutsBridge.setEnabled(false) }

  private fun event(key: Int) = KeyEvent(0, 0, KeyEvent.ACTION_DOWN, key, 0, 0, 1, 0, 0, InputDevice.SOURCE_KEYBOARD)

  @Test fun registeredInputKeysStayWithTheImeUntilCompositionEnds() {
    val input = EditText(RuntimeEnvironment.getApplication())
    input.setText("に")
    BaseInputConnection.setComposingSpans(input.text)
    assertFalse(HappierHardwareKeyboardShortcutsBridge.dispatchKeyEvent(event(KeyEvent.KEYCODE_ENTER), input))
    assertFalse(HappierHardwareKeyboardShortcutsBridge.dispatchKeyEvent(event(KeyEvent.KEYCODE_DPAD_UP), input))
    BaseInputConnection.removeComposingSpans(input.text)
    assertTrue(HappierHardwareKeyboardShortcutsBridge.dispatchKeyEvent(event(KeyEvent.KEYCODE_ENTER), input))
    assertTrue(HappierHardwareKeyboardShortcutsBridge.dispatchKeyEvent(event(KeyEvent.KEYCODE_DPAD_UP), input))
  }
}
