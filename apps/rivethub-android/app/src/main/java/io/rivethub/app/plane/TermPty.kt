package io.rivethub.app.plane

import io.rivethub.app.gateway.TermAttachInfo

/**
 * PTY attach protocol helpers — hello/mux, geometry, keys, the attach
 * command, detach-not-kill. Twin of den-server `term/ws.ts` client framing
 * and rivethub-web `xterm-attach.tsx`.
 *
 * Client sends binary keystrokes and JSON `{type:resize,cols,rows}` /
 * `{type:detach}`. Never `{type:kill}` — the manager TTL owns the PTY.
 *
 * den-server `term/ws.ts` replays the scrollback ring unconditionally after
 * hello (including `mux:tmux`). The client never skips that frame.
 */

const val TERM_MIN_COLS = 20
const val TERM_MAX_COLS = 500
const val TERM_MIN_ROWS = 5
const val TERM_MAX_ROWS = 200

/** Fallback JetBrains Mono aspect / line-height when a real glyph is not measured. */
const val TERM_MONO_ASPECT = 0.6f
const val TERM_LINE_HEIGHT = 1.2f

const val TERM_DETACH_JSON = """{"type":"detach"}"""

fun termResizeJson(cols: Int, rows: Int): String =
    """{"type":"resize","cols":$cols,"rows":$rows}"""

/**
 * "Use terminal here" → `{type:'claim'}` (den #681). Optional geometry is
 * applied like a resize; omitted → the den reuses this client's last resize.
 */
fun termClaimJson(cols: Int? = null, rows: Int? = null): String =
    if (cols != null && rows != null) """{"type":"claim","cols":$cols,"rows":$rows}"""
    else """{"type":"claim"}"""

/**
 * Hello-then-binary ordering pin. Binary before hello is dropped; every
 * binary after hello is written, including the ring.
 */
class TermReplayGate {
    enum class Phase { Hello, Live }

    var phase: Phase = Phase.Hello
        private set

    fun onHello() {
        phase = Phase.Live
    }

    /** True when this binary frame should be written to the VT. */
    fun acceptBinary(): Boolean = phase == Phase.Live

    fun reset() {
        phase = Phase.Hello
    }
}

/**
 * Fallback cell size. [fontScale] is Android's font scale (sp, not dp).
 * The pane prefers a measured "M" advance over this guess.
 */
fun termCellSizePx(fontSp: Float, density: Float, fontScale: Float): Pair<Float, Float> {
    val px = fontSp * density * fontScale
    val h = px * TERM_LINE_HEIGHT
    val w = px * TERM_MONO_ASPECT
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
    val UP: ByteArray = arrow('A', false)
    val DOWN: ByteArray = arrow('B', false)
    val RIGHT: ByteArray = arrow('C', false)
    val LEFT: ByteArray = arrow('D', false)

    fun utf8(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

    fun ctrl(ch: Char): ByteArray = byteArrayOf((ch.code and 0x1f).toByte())

    fun arrow(dir: Char, applicationCursor: Boolean): ByteArray {
        val intro = if (applicationCursor) 'O' else '['
        return byteArrayOf(0x1b, intro.code.toByte(), dir.code.toByte())
    }

    fun up(applicationCursor: Boolean = false): ByteArray = arrow('A', applicationCursor)
    fun down(applicationCursor: Boolean = false): ByteArray = arrow('B', applicationCursor)
    fun right(applicationCursor: Boolean = false): ByteArray = arrow('C', applicationCursor)
    fun left(applicationCursor: Boolean = false): ByteArray = arrow('D', applicationCursor)

    /**
     * IME / paste. Ctrl applies to the first ASCII character only
     * (`?`..`DEL`); the rest of the commit is literal UTF-8.
     */
    fun ime(text: String, ctrl: Boolean): ByteArray {
        if (!ctrl) return utf8(text)
        val c = text.firstOrNull() ?: return ByteArray(0)
        if (c.code !in 0x3f..0x7f) return utf8(text)
        return byteArrayOf((c.code and 0x1f).toByte()) + utf8(text.drop(1))
    }
}

/**
 * Render the desktop "Open in your terminal" command from the server
 * attach descriptor. Returns null when any required field is missing —
 * the affordance is hidden, never a guessed tmux line.
 *
 * [TermAttachInfo.local] is true only for loopback peers (never the
 * phone); the no-ssh form is still rendered so the field is not dropped.
 */
fun renderAttachCommand(info: TermAttachInfo?): String? {
    if (info == null) return null
    if (info.socket.isBlank() || info.session.isBlank()) return null
    return if (info.local) {
        "tmux -L ${info.socket} attach -t ${info.session}"
    } else {
        if (info.host.isBlank() || info.sshUser.isBlank()) return null
        "ssh ${info.sshUser}@${info.host} -t tmux -L ${info.socket} attach -t ${info.session}"
    }
}

interface TermSink {
    fun sendText(text: String): Boolean
    fun sendBinary(bytes: ByteArray): Boolean
    fun close()
}

/** Outbound side of one attach. [leave] detaches; it never sends kill. */
class TermPtyClient(private val sink: TermSink) {
    fun sendKeys(bytes: ByteArray): Boolean {
        if (bytes.isEmpty()) return true
        return sink.sendBinary(bytes)
    }

    fun resize(cols: Int, rows: Int): Boolean =
        sink.sendText(termResizeJson(cols, rows))

    /** Take ownership of the shared PTY with the current geometry. */
    fun claim(cols: Int, rows: Int): Boolean =
        sink.sendText(termClaimJson(cols, rows))

    fun leave() {
        sink.sendText(TERM_DETACH_JSON)
        sink.close()
    }
}

/**
 * Characters ADDED to the hidden IME field since the last value we saw: the tail after the
 * longest common prefix. Append-only by design — a shrinking value never yields backspaces
 * (deletion arrives as a hardware key event on the password-type field), the sentinel is
 * never forwarded, and CRLF / LF both become a single CR for the PTY.
 */
fun imeDelta(prev: String, cur: String, sentinel: String): String {
    var p = 0
    val max = minOf(prev.length, cur.length)
    while (p < max && prev[p] == cur[p]) p++
    val added = if (cur.length > p) cur.substring(p) else ""
    return added.replace(sentinel, "").replace("\r\n", "\r").replace("\n", "\r")
}
