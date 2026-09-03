package io.rivethub.app.plane

/**
 * PTY attach protocol helpers — hello/mux, geometry, keys, the attach
 * command, detach-not-kill. Twin of den-server `term/ws.ts` client framing
 * and rivethub-web `xterm-attach.tsx`.
 *
 * Client sends binary keystrokes and JSON `{type:resize,cols,rows}` /
 * `{type:detach}`. Never `{type:kill}` — the manager TTL owns the PTY.
 */

const val TERM_MIN_COLS = 20
const val TERM_MAX_COLS = 500
const val TERM_MIN_ROWS = 5
const val TERM_MAX_ROWS = 200

/** JetBrains Mono aspect (em width) and line-height used for cols/rows. */
const val TERM_MONO_ASPECT = 0.6f
const val TERM_LINE_HEIGHT = 1.2f

const val TERM_DETACH_JSON = """{"type":"detach"}"""

fun termResizeJson(cols: Int, rows: Int): String =
    """{"type":"resize","cols":$cols,"rows":$rows}"""

fun skipRingReplay(mux: String?): Boolean =
    mux?.equals("tmux", ignoreCase = true) == true

/**
 * First hello, then one binary ring frame, then live bytes.
 * `mux:tmux` → clear the local buffer and drop the ring; absent/`none` → replay.
 */
class TermReplayGate {
    enum class Phase { Hello, Ring, Live }

    var phase: Phase = Phase.Hello
        private set
    var skipRing: Boolean = false
        private set

    fun onHello(mux: String?) {
        skipRing = skipRingReplay(mux)
        phase = Phase.Ring
    }

    /** True when this binary frame should be written to the VT. */
    fun acceptBinary(): Boolean = when (phase) {
        Phase.Hello -> false
        Phase.Ring -> {
            phase = Phase.Live
            !skipRing
        }
        Phase.Live -> true
    }

    fun reset() {
        phase = Phase.Hello
        skipRing = false
    }
}

fun termCellSizePx(fontSp: Float, density: Float): Pair<Float, Float> {
    val h = fontSp * density * TERM_LINE_HEIGHT
    val w = fontSp * density * TERM_MONO_ASPECT
    return w to h
}

/**
 * Cols/rows from the pane size and a cell. Null when the pane is not yet
 * laid out (a 0×0 fit must not ship a resize).
 */
fun termColsRows(widthPx: Float, heightPx: Float, cellW: Float, cellH: Float): Pair<Int, Int>? {
    if (widthPx < 1f || heightPx < 1f || cellW < 1f || cellH < 1f) return null
    val cols = kotlin.math.floor(widthPx / cellW).toInt().coerceIn(TERM_MIN_COLS, TERM_MAX_COLS)
    val rows = kotlin.math.floor(heightPx / cellH).toInt().coerceIn(TERM_MIN_ROWS, TERM_MAX_ROWS)
    return cols to rows
}

object TermKeys {
    val ENTER: ByteArray = byteArrayOf(0x0d)
    val BACKSPACE: ByteArray = byteArrayOf(0x7f)
    val ESC: ByteArray = byteArrayOf(0x1b)
    val TAB: ByteArray = byteArrayOf(0x09)
    val UP: ByteArray = byteArrayOf(0x1b, '['.code.toByte(), 'A'.code.toByte())
    val DOWN: ByteArray = byteArrayOf(0x1b, '['.code.toByte(), 'B'.code.toByte())
    val RIGHT: ByteArray = byteArrayOf(0x1b, '['.code.toByte(), 'C'.code.toByte())
    val LEFT: ByteArray = byteArrayOf(0x1b, '['.code.toByte(), 'D'.code.toByte())

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun ctrl(ch: Char): ByteArray = byteArrayOf((ch.code and 0x1f).toByte())

    /** IME / paste: Ctrl latched → each codepoint becomes a control byte. */
    fun ime(text: String, ctrl: Boolean): ByteArray {
        if (!ctrl) return utf8(text)
        val out = ByteArray(text.length)
        for (i in text.indices) out[i] = (text[i].code and 0x1f).toByte()
        return out
    }
}

/**
 * Render the desktop "Open in your terminal" command from the server
 * attach descriptor. Returns null when any field is missing — the
 * affordance is hidden, never a guessed tmux line.
 */
fun renderAttachCommand(socket: String?, session: String?, host: String?, sshUser: String?): String? {
    if (socket.isNullOrBlank() || session.isNullOrBlank() || host.isNullOrBlank() || sshUser.isNullOrBlank()) {
        return null
    }
    return "ssh $sshUser@$host -t tmux -L $socket attach -t $session"
}

interface TermSink {
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
    fun close()
}

/** Outbound side of one attach. [leave] detaches; it never sends kill. */
class TermPtyClient(private val sink: TermSink) {
    val replay = TermReplayGate()

    fun sendKeys(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return true
        return sink.sendBinary(bytes)
    }

    fun resize(cols: Int, rows: Int): Boolean =
        sink.sendText(termResizeJson(cols, rows))

    fun leave() {
        sink.sendText(TERM_DETACH_JSON)
        sink.close()
    }
}

class RecordingTermSink : TermSink {
    val texts = ArrayList<String>()
    val binaries = ArrayList<ByteArray>()
    var closed: Boolean = false
        private set

    override fun sendText(text: String): Boolean {
        texts += text
        return true
    }

    override fun sendBinary(bytes: ByteArray): Boolean {
        binaries += bytes
        return true
    }

    override fun close() {
        closed = true
    }
}
