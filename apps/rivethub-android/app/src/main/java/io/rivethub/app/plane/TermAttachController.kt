package io.rivethub.app.plane

import io.rivethub.app.gateway.TermFrame
import io.rivethub.app.gateway.TermSpawnResponse
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.parseTermFrame
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class TermStatus { Closed, Connecting, Attached, Exited }

data class TermAttachView(
    val status: TermStatus = TermStatus.Closed,
    val rev: Int = 0,
    val attachCommand: String? = null,
    val clipboard: String? = null,
    val ctrl: Boolean = false,
    val ctrlLocked: Boolean = false,
    val error: String? = null,
)

interface TermScreenPort {
    fun reset(cols: Int, rows: Int)
    fun resize(cols: Int, rows: Int)
    fun feed(bytes: ByteArray)
    fun drainOsc52(): List<String>
    val generation: Int
}

interface TermSocket : TermSink {
    var reconnectOnClose: Boolean
}

fun interface TermSpawnPort {
    suspend fun spawn(
        session: String,
        cols: Int,
        rows: Int,
        command: String?,
        model: String?,
        effort: String?,
    ): TermSpawnResponse
}

fun interface TermWatchFactory {
    fun watch(
        ptyId: String,
        onText: (String) -> Unit,
        onBinary: (ByteArray) -> Unit,
        onStatus: (WsStatus) -> Unit,
    ): TermSocket
}

private sealed interface TermIn {
    val seq: Int
    class Text(override val seq: Int, val text: String) : TermIn
    class Binary(override val seq: Int, val bytes: ByteArray) : TermIn
    class Status(override val seq: Int, val status: WsStatus) : TermIn
}

/**
 * Attach lifecycle for one chat PTY. Spawn + socket ports are interfaces
 * so JVM tests can drive hello → ring, reconnect, leave, background, a
 * generation bump, and the draft path without `AppContainer`.
 *
 * Inbound frames share one [Channel] drained by a single consumer — the
 * hello → ring order is structural, not a coincidence of OkHttp + Main.
 */
class TermAttachController(
    private val scope: CoroutineScope,
    private val spawn: TermSpawnPort,
    private val watch: TermWatchFactory,
    private val screen: TermScreenPort,
    private val attachedGen: Int,
    private val currentGen: () -> Int,
    private val sessionId: () -> String,
    private val isDraft: () -> Boolean,
    private val spawnAndAdopt: suspend () -> Unit,
    private val command: () -> String?,
    private val flags: () -> SpawnFlags,
    private val onPublish: (TermAttachView) -> Unit,
    private val coalesceMs: Long = 16L,
) {
    private val incoming = Channel<TermIn>(Channel.UNLIMITED)
    private val replay = TermReplayGate()
    private var client: TermPtyClient? = null
    private var socket: TermSocket? = null
    private var attachJob: Job? = null
    private val consumerJob: Job = scope.launch { consume() }
    private var wanted = false
    private var seq = 0
    private var cols = 80
    private var rows = 24
    private var status = TermStatus.Closed
    private var attachCommand: String? = null
    private var clipboard: String? = null
    private var ctrl = false
    private var ctrlLocked = false
    private var error: String? = null

    fun ensure() {
        wanted = true
        if (currentGen() != attachedGen) {
            drop()
            return
        }
        if (socket != null) return
        if (attachJob?.isActive == true) return
        attachJob = scope.launch { attach() }
    }

    fun onBackground() {
        detach(keepWanted = true, clearCommand = false)
    }

    fun onForeground() {
        if (wanted) ensure()
    }

    fun userDetach() {
        wanted = false
        detach(keepWanted = false, clearCommand = true)
    }

    fun drop() {
        wanted = false
        detach(keepWanted = false, clearCommand = true)
    }

    fun close() {
        wanted = false
        detach(keepWanted = false, clearCommand = true)
        consumerJob.cancel()
        incoming.close()
    }

    fun resize(newCols: Int, newRows: Int) {
        if (newCols == cols && newRows == rows) return
        cols = newCols
        rows = newRows
        screen.resize(cols, rows)
        client?.resize(cols, rows)
        publish()
    }

    fun sendBytes(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        if (currentGen() != attachedGen) return
        consumeCtrl()
        client?.sendKeys(bytes)
    }

    fun sendText(text: String) {
        if (text.isEmpty()) return
        if (currentGen() != attachedGen) return
        val latched = consumeCtrl()
        client?.sendKeys(TermKeys.ime(text, latched))
    }

    fun toggleCtrl() {
        if (ctrlLocked) {
            ctrlLocked = false
            ctrl = false
        } else {
            ctrl = !ctrl
        }
        publish()
    }

    fun lockCtrl() {
        ctrl = true
        ctrlLocked = true
        publish()
    }

    fun consumeClipboard() {
        clipboard = null
        publish()
    }

    private fun consumeCtrl(): Boolean {
        val was = ctrl
        if (was && !ctrlLocked) {
            ctrl = false
            publish()
        }
        return was
    }

    private suspend fun attach() {
        if (currentGen() != attachedGen) return
        status = TermStatus.Connecting
        error = null
        publish()
        try {
            if (isDraft()) {
                spawnAndAdopt()
                if (isDraft()) {
                    status = TermStatus.Closed
                    error = "session was not adopted"
                    publish()
                    return
                }
            }
            val spawnedFlags = flags()
            val spawned = spawn.spawn(
                session = sessionId(),
                cols = cols,
                rows = rows,
                command = command(),
                model = spawnedFlags.model,
                effort = spawnedFlags.effort,
            )
            if (currentGen() != attachedGen) return
            attachCommand = renderAttachCommand(spawned.attach)
            screen.reset(cols, rows)
            replay.reset()
            val mySeq = ++seq
            var sock: TermSocket? = null
            val pty = TermPtyClient(
                object : TermSink {
                    override fun sendText(text: String): Boolean = sock?.sendText(text) ?: false
                    override fun sendBinary(bytes: ByteArray): Boolean = sock?.sendBinary(bytes) ?: false
                    override fun close() { sock?.close() }
                },
            )
            sock = watch.watch(
                spawned.id,
                onText = { incoming.trySend(TermIn.Text(mySeq, it)) },
                onBinary = { incoming.trySend(TermIn.Binary(mySeq, it)) },
                onStatus = { incoming.trySend(TermIn.Status(mySeq, it)) },
            )
            client = pty
            socket = sock
            publish()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            status = TermStatus.Closed
            error = e.message ?: e.javaClass.simpleName
            publish()
        }
    }

    private fun detach(keepWanted: Boolean, clearCommand: Boolean) {
        if (!keepWanted) wanted = false
        seq++
        val leaving = client
        client = null
        socket = null
        attachJob?.cancel()
        attachJob = null
        leaving?.leave()
        status = TermStatus.Closed
        if (clearCommand) attachCommand = null
        publish()
    }

    private suspend fun consume() {
        val pending = ArrayList<ByteArray>()
        try {
            while (currentCoroutineContext().isActive) {
                val first = incoming.receive()
                collect(first, pending)
                if (pending.isNotEmpty() && coalesceMs > 0) delay(coalesceMs)
                while (true) {
                    val next = incoming.tryReceive().getOrNull() ?: break
                    collect(next, pending)
                }
                flushBinary(pending)
            }
        } catch (_: ClosedReceiveChannelException) {
        }
    }

    private fun collect(msg: TermIn, pending: ArrayList<ByteArray>) {
        if (msg.seq != seq) return
        when (msg) {
            is TermIn.Text -> {
                flushBinary(pending)
                onText(msg.text)
            }
            is TermIn.Binary -> pending.add(msg.bytes)
            is TermIn.Status -> {
                flushBinary(pending)
                onStatus(msg.status)
            }
        }
    }

    private fun flushBinary(pending: ArrayList<ByteArray>) {
        if (pending.isEmpty()) return
        val all = if (pending.size == 1) pending[0] else {
            val n = pending.sumOf { it.size }
            val out = ByteArray(n)
            var o = 0
            for (b in pending) {
                b.copyInto(out, o)
                o += b.size
            }
            out
        }
        pending.clear()
        onBinary(all)
    }

    private fun onText(text: String) {
        when (val frame = parseTermFrame(text)) {
            is TermFrame.Hello -> {
                replay.onHello()
                screen.reset(cols, rows)
                if (frame.frame.state == "exited") {
                    socket?.reconnectOnClose = false
                    status = TermStatus.Exited
                } else {
                    status = TermStatus.Attached
                }
                client?.resize(cols, rows)
                publish()
            }
            is TermFrame.Exit -> {
                socket?.reconnectOnClose = false
                status = TermStatus.Exited
                publish()
            }
            null -> Unit
        }
    }

    private fun onBinary(bytes: ByteArray) {
        if (!replay.acceptBinary()) return
        screen.feed(bytes)
        val clips = screen.drainOsc52()
        if (clips.isNotEmpty()) clipboard = clips.last()
        publish()
    }

    private fun onStatus(s: WsStatus) {
        when (s) {
            WsStatus.CONNECTING -> {
                status = TermStatus.Connecting
                publish()
            }
            WsStatus.OPEN -> {
                replay.reset()
                screen.reset(cols, rows)
                client?.resize(cols, rows)
                status = TermStatus.Attached
                publish()
            }
            WsStatus.CLOSED -> {
                if (status != TermStatus.Exited) status = TermStatus.Closed
                publish()
            }
        }
    }

    private fun publish() {
        onPublish(
            TermAttachView(
                status = status,
                rev = screen.generation,
                attachCommand = attachCommand,
                clipboard = clipboard,
                ctrl = ctrl,
                ctrlLocked = ctrlLocked,
                error = error,
            ),
        )
    }
}
