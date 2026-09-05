package dev.rivet.app.ui.pages.terminal

import android.content.Context
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import com.termux.terminal.TerminalEmulator
import com.termux.view.TerminalView

/**
 * Invisible 1×1 view that owns keyboard focus for the terminal so *we* choose what the IME sees.
 *
 * Termux's [TerminalView] is final and advertises itself as either a visible-password field
 * (char-based input) or `TYPE_NULL`; Gboard hides its microphone on both, so voice typing was
 * unreachable. This proxy advertises `TYPE_CLASS_TEXT | NO_SUGGESTIONS` — per-key commits, no
 * autocorrect, mic available — and forwards everything to the real view's public input API:
 * text through [TerminalView.inputCodePoint] (which honours the sticky CTRL/ALT modifiers via the
 * client), key events through [TerminalView.onKeyDown]/[TerminalView.onKeyUp] (Enter, Backspace,
 * hardware keyboards). The forwarding mirrors Termux's own `sendTextToTerminal`, including the
 * control-character → CTRL+letter mapping.
 */
class TerminalInputProxy(context: Context) : View(context) {

    var terminalView: TerminalView? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or
            InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
            InputType.TYPE_TEXT_FLAG_MULTI_LINE
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_ENTER_ACTION
        return object : BaseInputConnection(this, true) {
            override fun finishComposingText(): Boolean {
                super.finishComposingText()
                editable?.let { sendTextToTerminal(it); it.clear() }
                return true
            }

            override fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
                super.commitText(text, newCursorPosition)
                editable?.let { sendTextToTerminal(it); it.clear() }
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                val del = KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL)
                repeat(beforeLength) { sendKeyEvent(del) }
                return super.deleteSurroundingText(beforeLength, afterLength)
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean =
        terminalView?.onKeyDown(keyCode, event) ?: super.onKeyDown(keyCode, event)

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        terminalView?.onKeyUp(keyCode, event) ?: super.onKeyUp(keyCode, event)

    private fun sendTextToTerminal(text: CharSequence) {
        val tv = terminalView ?: return
        if (tv.mEmulator == null) return
        var i = 0
        val n = text.length
        while (i < n) {
            val first = text[i]
            var codePoint: Int = if (Character.isHighSurrogate(first)) {
                if (++i < n) Character.toCodePoint(first, text[i]) else TerminalEmulator.UNICODE_REPLACEMENT_CHAR
            } else {
                first.code
            }
            var ctrlHeld = false
            if (codePoint <= 31 && codePoint != 27) {
                if (codePoint == '\n'.code) codePoint = '\r'.code
                ctrlHeld = true
                codePoint = when (codePoint) {
                    31 -> '_'.code
                    30 -> '^'.code
                    29 -> ']'.code
                    28 -> '\\'.code
                    else -> codePoint + 96
                }
            }
            tv.inputCodePoint(codePoint, ctrlHeld, false)
            i++
        }
    }
}
