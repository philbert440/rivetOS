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
import java.util.UUID
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

    /** Inline error for the UI when the remote node is unreachable (not a crash). */
    @Volatile
    var errorMessage: String? = null
        private set

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        runCatching { webSocket?.close(1000, "client close") }
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
                    val ws = webSocket ?: break
                    if (!den.sendBytes(ws, buf, 0, n)) break
                }
            } catch (e: Exception) {
                if (!closed.get()) Log.d(TAG, "key reader ended: ${e.message}")
            }
        }
    }

    private fun attachWebSocket() {
        val ws = den.connect(
            ptyId,
            object : DenTermClient.Listener {
                override fun onOpen() {
                    Log.i(TAG, "attached to remote pty $ptyId")
                    val socket = webSocket ?: return
                    if (lastCols >= 20 && lastRows >= 5) {
                        den.sendResize(socket, lastCols, lastRows)
                    }
                }

                override fun onText(text: String) {
                    onWsText(text)
                }

                override fun onBinary(data: ByteArray) {
                    onWsBinary(data)
                }

                override fun onClosed(code: Int, reason: String) {
                    if (closed.get()) return
                    Log.i(TAG, "remote ws closed code=$code reason=$reason")
                    mainHandler.post {
                        handle.finished = true
                        TerminalSessionStore.onFinished(handle.key)
                    }
                }

                override fun onFailure(error: Throwable) {
                    if (closed.get()) return
                    fail(
                        "Remote terminal unreachable: ${error.message ?: error.javaClass.simpleName}",
                    )
                    TerminalSessionStore.onFinished(handle.key)
                }
            },
        )
        webSocket = ws
    }

    private fun onWsBinary(data: ByteArray) {
        if (closed.get() || data.isEmpty()) return
        try {
            outStream?.write(data)
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

        /**
         * Spawn/attach a remote den PTY and wire it into a local [TerminalHandle] via FIFOs.
         * Throws [java.io.IOException] with a user-facing message on failure.
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
            val den = DenTermClient(denUrl, token)
            val cfg = runCatching { den.termConfig() }.getOrNull()
            if (cfg != null && !cfg.enabled) {
                throw java.io.IOException("Terminal is disabled on this node")
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
                throw java.io.IOException("Could not create terminal bridge directory")
            }
            val inFifo = File(bridgeDir, "in")
            val outFifo = File(bridgeDir, "out")
            try {
                Os.mkfifo(inFifo.absolutePath, 384) // 0600
                Os.mkfifo(outFifo.absolutePath, 384)
            } catch (e: Exception) {
                bridgeDir.deleteRecursively()
                throw java.io.IOException("Could not create terminal pipes: ${e.message}", e)
            }

            // Relay: remote bytes from outFifo → PTY stdout; keystrokes → inFifo.
            val shellCmd =
                "cat '${outFifo.absolutePath}' & cat > '${inFifo.absolutePath}'; wait"
            val client = RivetTerminalClient()
            val session = TerminalSession(
                "/system/bin/sh",
                bridgeDir.absolutePath,
                arrayOf("sh", "-c", shellCmd),
                arrayOf("TERM=xterm-256color", "COLORTERM=truecolor"),
                4000,
                client,
            )
            val handle = TerminalHandle(key, session, client, title, conversationId)
            client.handle = handle

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
            remote.startFifoBridges()
            remote.attachWebSocket()
            return remote
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
