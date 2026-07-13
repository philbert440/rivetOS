package dev.rivet.app.ui.pages.terminal

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.termux.terminal.TerminalSession
import okhttp3.WebSocket
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Remote den terminal attached to the same Termux [TerminalSession]/[com.termux.view.TerminalView]
 * stack as local.
 *
 * Transport is den WS ([DenTermClient]); the local process is only a FIFO relay so keystrokes and
 * remote bytes still flow through Termux's PTY → emulator path (no custom renderer).
 *
 * ```
 * keystrokes → TerminalSession.write → PTY → cat > inFifo → reader → WS binary
 * WS binary  → writer → outFifo → cat outFifo → PTY → emulator
 * ```
 */
internal class RemoteTermSession private constructor(
    val handle: TerminalHandle,
    private val bridgeDir: File,
    private val inFifo: File,
    private val outFifo: File,
    private val den: DenTermClient,
    private val ptyId: String,
) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val closed = AtomicBoolean(false)
    private var lastCols = 80
    private var lastRows = 24
    private var webSocket: WebSocket? = null
    private var inStream: FileInputStream? = null
    private var outStream: FileOutputStream? = null

    /**
     * True while [open] is still waiting for the first WS frame. Failures in this phase
     * surface as thrown IOExceptions rather than mid-session UI finish events.
     */
    @Volatile
    private var awaitingFirstByte = false

    /** Inline error for the UI when the remote node is unreachable (not a crash). */
    @Volatile
    var errorMessage: String? = null
        private set

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        // cancel() aborts immediately (incl. connect-in-flight); close() alone can linger.
        runCatching { webSocket?.cancel() }
        webSocket = null
        runCatching { handle.session.finishIfRunning() }
        runCatching { inStream?.close() }
        runCatching { outStream?.close() }
        runCatching { inFifo.delete() }
        runCatching { outFifo.delete() }
        runCatching { bridgeDir.deleteRecursively() }
    }

    /** Push a resize control frame when the view's emulator size changes. */
    fun maybeResize(cols: Int, rows: Int) {
        if (closed.get()) return
        if (cols < 2 || rows < 2) return
        if (cols == lastCols && rows == lastRows) return
        lastCols = cols
        lastRows = rows
        val ws = webSocket ?: return
        den.sendResize(ws, cols, rows)
    }

    private fun startFifoBridges() {
        // Os.open returns FileDescriptor; O_RDWR avoids blocking for the peer side of a FIFO.
        val inFd = try {
            Os.open(inFifo.absolutePath, OsConstants.O_RDWR, 0)
        } catch (e: Exception) {
            fail("Failed to open terminal input pipe: ${e.message}")
            return
        }
        val outFd = try {
            Os.open(outFifo.absolutePath, OsConstants.O_RDWR, 0)
        } catch (e: Exception) {
            runCatching { Os.close(inFd) }
            fail("Failed to open terminal output pipe: ${e.message}")
            return
        }
        inStream = FileInputStream(inFd)
        outStream = FileOutputStream(outFd)

        thread(name = "RemoteTerm-keys-$ptyId", isDaemon = true) {
            val buf = ByteArray(4096)
            try {
                while (!closed.get()) {
                    val n = inStream?.read(buf) ?: -1
                    if (n < 0) break
                    if (n == 0) continue
                    // Drop OSC color *reports* (xterm answers to 10/11/12 queries) so they
                    // never hit the remote harness as typed garbage — web XtermAttach parity.
                    if (OscFilter.isOscColorReport(buf, 0, n)) continue
                    val ws = webSocket ?: break
                    if (!den.sendBytes(ws, buf, 0, n)) break
                }
            } catch (e: Exception) {
                if (!closed.get()) Log.d(TAG, "key reader ended: ${e.message}")
            }
        }
    }

    /**
     * Open the WS and block until the first server frame (hello JSON or binary scrollback),
     * or fail with a clear error. Reachable-but-hung dens must not leave the UI spinning.
     */
    private fun attachWebSocketAwaitFirstByte(timeoutMs: Long) {
        val firstByte = CountDownLatch(1)
        var openFailure: Throwable? = null
        awaitingFirstByte = true

        val ws = den.connect(
            ptyId,
            object : DenTermClient.Listener {
                override fun onOpen() {
                    Log.i(TAG, "attached to remote pty $ptyId")
                    val socket = webSocket ?: return
                    if (lastCols >= 20 && lastRows >= 5) {
                        den.sendResize(socket, lastCols, lastRows)
                    }
                    // Do not count TCP/WS open as first byte — wait for den hello/binary.
                }

                override fun onText(text: String) {
                    onWsText(text)
                    firstByte.countDown()
                }

                override fun onBinary(data: ByteArray) {
                    onWsBinary(data)
                    firstByte.countDown()
                }

                override fun onClosed(code: Int, reason: String) {
                    if (awaitingFirstByte) {
                        openFailure = IOException("Remote terminal closed before data (code=$code)")
                        firstByte.countDown()
                        return
                    }
                    if (closed.get()) return
                    Log.i(TAG, "remote ws closed code=$code reason=$reason")
                    mainHandler.post {
                        handle.finished = true
                        TerminalSessionStore.onFinished(handle.key)
                    }
                }

                override fun onFailure(error: Throwable) {
                    if (awaitingFirstByte) {
                        openFailure = error
                        firstByte.countDown()
                        return
                    }
                    if (closed.get()) return
                    fail(
                        "Remote terminal unreachable: ${error.message ?: error.javaClass.simpleName}",
                    )
                    TerminalSessionStore.onFinished(handle.key)
                }
            },
        )
        webSocket = ws

        val gotFirst = try {
            firstByte.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        awaitingFirstByte = false

        if (!gotFirst) {
            val msg =
                "Remote terminal timed out waiting for data (${timeoutMs / 1000}s). " +
                    "The node is reachable but its den did not send a terminal frame."
            errorMessage = msg
            close()
            throw IOException(msg)
        }
        openFailure?.let { err ->
            val msg =
                "Remote terminal unreachable: ${err.message ?: err.javaClass.simpleName}"
            errorMessage = msg
            close()
            throw IOException(msg, err)
        }
        if (closed.get()) {
            throw IOException(errorMessage ?: "Remote terminal failed during connect")
        }
    }

    private fun onWsBinary(data: ByteArray) {
        if (closed.get() || data.isEmpty()) return
        // Strip OSC 10/11/12 color *queries* before they hit the local emulator
        // (web XtermAttach parity — prevents rgb: report echo garbage).
        val filtered = OscFilter.stripOscColorQueries(data)
        if (filtered.isEmpty()) return
        try {
            outStream?.write(filtered)
            outStream?.flush()
        } catch (e: Exception) {
            if (!closed.get()) Log.w(TAG, "outFifo write failed: ${e.message}")
        }
    }

    private fun onWsText(text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (obj.optString("type")) {
            "hello" -> {
                val ws = webSocket ?: return
                if (lastCols >= 20 && lastRows >= 5) {
                    den.sendResize(ws, lastCols, lastRows)
                }
            }
            "exit" -> {
                val code = if (obj.isNull("code")) null else obj.optInt("code")
                Log.i(TAG, "remote pty $ptyId exited code=$code")
            }
        }
    }

    private fun fail(message: String) {
        Log.e(TAG, message)
        errorMessage = message
        mainHandler.post {
            handle.finished = true
        }
        close()
    }

    companion object {
        private const val TAG = "RemoteTermSession"
        /** Wait this long after WS open for hello/binary before failing the spinner. */
        private const val FIRST_BYTE_TIMEOUT_MS = 15_000L

        /**
         * Spawn/attach a remote den PTY and wire it into a local [TerminalHandle] via FIFOs.
         * Throws [IOException] with a user-facing message on failure (including hung den /
         * first-byte timeout). Uses the process-shared OkHttp client — no per-open leak.
         */
        fun open(
            context: Context,
            key: String,
            title: String,
            denUrl: String,
            token: String?,
            launchCommand: List<String>,
            conversationId: String?,
            cols: Int = 80,
            rows: Int = 24,
        ): RemoteTermSession {
            // Shared OkHttp pool — never construct a fresh client per open.
            val den = DenTermClient(denUrl, token, DenTermClient.sharedClient())
            val cfg = runCatching { den.termConfig() }.getOrNull()
            if (cfg != null && !cfg.enabled) {
                throw IOException("Terminal is disabled on this node")
            }

            val spawnReq = DenTermClient.spawnRequestFor(launchCommand, conversationId)
            val existing = conversationId?.let { sid ->
                runCatching {
                    den.termList().firstOrNull { it.denSession == sid && it.state == "running" }
                }.getOrNull()
            }
            val ptyId = if (existing != null) {
                existing.id
            } else {
                val command = resolveCommand(spawnReq.command, cfg)
                den.termSpawn(
                    command = command,
                    session = spawnReq.session,
                    resume = spawnReq.resume,
                    cols = cols,
                    rows = rows,
                ).id
            }

            val bridgeDir = File(context.cacheDir, "remote-term/${UUID.randomUUID()}")
            if (!bridgeDir.mkdirs()) {
                throw IOException("Could not create terminal bridge directory")
            }
            val inFifo = File(bridgeDir, "in")
            val outFifo = File(bridgeDir, "out")
            try {
                Os.mkfifo(inFifo.absolutePath, 384) // 0600
                Os.mkfifo(outFifo.absolutePath, 384)
            } catch (e: Exception) {
                bridgeDir.deleteRecursively()
                throw IOException("Could not create terminal pipes: ${e.message}", e)
            }

            // Relay: remote bytes from outFifo → PTY stdout; keystrokes → inFifo.
            // Termux TerminalSession constructs a MainThreadHandler — it MUST be created
            // on the main looper. open() is invoked from Dispatchers.IO (TerminalPage) so
            // network spawn stays off-main; hop to main only for this constructor.
            val shellCmd =
                "cat '${outFifo.absolutePath}' & cat > '${inFifo.absolutePath}'; wait"
            val handle = runOnMainBlocking {
                val client = RivetTerminalClient()
                val session = TerminalSession(
                    "/system/bin/sh",
                    bridgeDir.absolutePath,
                    arrayOf("sh", "-c", shellCmd),
                    arrayOf("TERM=xterm-256color", "COLORTERM=truecolor"),
                    4000,
                    client,
                )
                TerminalHandle(key, session, client, title, conversationId).also {
                    client.handle = it
                }
            }

            val remote = RemoteTermSession(
                handle = handle,
                bridgeDir = bridgeDir,
                inFifo = inFifo,
                outFifo = outFifo,
                den = den,
                ptyId = ptyId,
            )
            remote.lastCols = cols
            remote.lastRows = rows
            try {
                remote.startFifoBridges()
                remote.attachWebSocketAwaitFirstByte(FIRST_BYTE_TIMEOUT_MS)
            } catch (e: Exception) {
                remote.close()
                throw if (e is IOException) e else IOException(e.message ?: "Remote terminal failed", e)
            }
            return remote
        }

        /**
         * Run [block] on the main looper (blocking the caller). Termux's
         * [TerminalSession] requires this; network I/O stays on the caller's thread.
         */
        private fun <T> runOnMainBlocking(block: () -> T): T {
            if (Looper.myLooper() == Looper.getMainLooper()) return block()
            val latch = CountDownLatch(1)
            val box = arrayOfNulls<Any>(1)
            var error: Throwable? = null
            Handler(Looper.getMainLooper()).post {
                try {
                    @Suppress("UNCHECKED_CAST")
                    box[0] = block() as Any?
                } catch (t: Throwable) {
                    error = t
                } finally {
                    latch.countDown()
                }
            }
            if (!latch.await(30, TimeUnit.SECONDS)) {
                throw IOException("Timed out waiting for main thread to create terminal session")
            }
            error?.let { throw it }
            @Suppress("UNCHECKED_CAST")
            return box[0] as T
        }

        /** Pick a roster key that exists on the node when possible. */
        private fun resolveCommand(wanted: String?, cfg: DenTermClient.TermConfig?): String? {
            if (cfg == null) return wanted
            val cmds = cfg.commands
            if (wanted != null && cmds.contains(wanted)) return wanted
            if (wanted == "shell" || wanted == null) {
                when {
                    cmds.contains("shell") -> return "shell"
                    cmds.contains(cfg.defaultCommand) -> return cfg.defaultCommand
                    cmds.isNotEmpty() -> return cmds.first()
                }
            }
            if (wanted != null && !cmds.contains(wanted)) {
                if (cmds.contains(cfg.defaultCommand)) return cfg.defaultCommand
                if (cmds.contains("shell")) return "shell"
            }
            return wanted ?: cfg.defaultCommand
        }
    }
}
