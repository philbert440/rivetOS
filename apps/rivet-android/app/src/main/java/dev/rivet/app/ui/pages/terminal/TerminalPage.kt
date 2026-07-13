package dev.rivet.app.ui.pages.terminal

import android.content.Context
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.view.TerminalView
import com.termux.view.TerminalViewClient
import dev.rivet.app.data.datastore.NodeRosterDefaults
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.runtime.RivetRuntime
import dev.rivet.app.service.ChatService
import dev.rivet.app.ui.context.LocalNavController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.withContext
import org.koin.compose.koinInject
import kotlin.uuid.Uuid

private const val TAG = "RivetTerminal"

/**
 * Process-level registry of live terminal sessions, keyed by the launch command (+ den URL for
 * remote). Keeps the proot+CLI process (local) or remote den PTY attachment alive when you
 * navigate back to chat, so re-entering the terminal reattaches to the SAME running session.
 * A session is dropped when its process exits, it's explicitly restarted, or the chat GUI
 * starts a bridge turn on the same conversation (see [dropForConversation]).
 */
internal object TerminalSessionStore {
    private val handles = HashMap<String, TerminalHandle>()
    private val remotes = HashMap<String, RemoteTermSession>()

    @Synchronized
    fun acquire(
        context: Context,
        key: String,
        title: String,
        launchCommand: List<String>,
        conversationId: String? = null,
    ): TerminalHandle? {
        handles[key]?.let { existing ->
            if (!existing.finished && existing.session.isRunning) return existing
            remotes.remove(key)?.close()
            handles.remove(key) // dead — fall through and recreate
        }
        if (!RivetRuntime.isRootfsReady(context)) return null
        RivetRuntime.prepare(context) // ensure symlinks/user/bridge scaffold before launch
        val client = RivetTerminalClient()
        val cmd = RivetRuntime.terminalCommand(context, launchCommand)
        val session = TerminalSession(cmd.executable, cmd.cwd, cmd.args, cmd.env, 4000, client)
        val handle = TerminalHandle(key, session, client, title, conversationId)
        client.handle = handle
        handles[key] = handle
        return handle
    }

    /**
     * Attach to the active remote node's den terminal over WebSocket. Does not need the local
     * proot rootfs. [errorOut] receives a clear message if the node is unreachable.
     *
     * Network I/O intentionally runs outside the registry lock so a slow den cannot stall
     * local terminal acquires.
     */
    fun acquireRemote(
        context: Context,
        key: String,
        title: String,
        denUrl: String,
        token: String?,
        launchCommand: List<String>,
        conversationId: String? = null,
        errorOut: (String) -> Unit,
    ): TerminalHandle? {
        synchronized(this) {
            handles[key]?.let { existing ->
                if (!existing.finished && existing.session.isRunning) return existing
                remotes.remove(key)?.close()
                handles.remove(key)
            }
        }
        return try {
            val remote = RemoteTermSession.open(
                context = context,
                key = key,
                title = title,
                denUrl = denUrl,
                token = token,
                launchCommand = launchCommand,
                conversationId = conversationId,
            )
            synchronized(this) {
                // Another caller may have won a race; prefer the live one.
                handles[key]?.let { existing ->
                    if (!existing.finished && existing.session.isRunning && existing !== remote.handle) {
                        remote.close()
                        return existing
                    }
                }
                remotes[key] = remote
                handles[key] = remote.handle
            }
            remote.errorMessage?.let(errorOut)
            remote.handle
        } catch (e: Exception) {
            Log.e(TAG, "remote terminal open failed", e)
            errorOut(e.message ?: "Remote terminal unreachable")
            null
        }
    }

    @Synchronized
    fun remoteFor(key: String): RemoteTermSession? = remotes[key]

    /** Kill + forget a session (Restart). */
    @Synchronized
    fun drop(key: String) {
        remotes.remove(key)?.close()
        handles.remove(key)?.session?.finishIfRunning()
    }

    /**
     * Kill any terminal session resuming [conversationId]. Called when the chat GUI starts
     * a bridge turn on that conversation — the terminal CLI's snapshot is stale from then on,
     * so the next escalate re-resumes from disk and sees the new turns.
     */
    @Synchronized
    fun dropForConversation(conversationId: String) {
        handles.values.filter { it.conversationId == conversationId }
            .forEach { drop(it.key) }
    }

    /** The process exited on its own; allow a fresh one next time. */
    @Synchronized
    fun onFinished(key: String) {
        remotes.remove(key)?.close()
        handles.remove(key)
    }
}

/** A persistent terminal session + its UI state, held in [TerminalSessionStore]. */
internal class TerminalHandle(
    val key: String,
    val session: TerminalSession,
    val client: RivetTerminalClient,
    initialTitle: String,
    val conversationId: String? = null,
) {
    var title by mutableStateOf(initialTitle)
    var finished by mutableStateOf(false)
    // Sticky CTRL/ALT modifiers — live with the session so they're consistent across re-entries.
    val ctrlHeld = mutableStateOf(false)
    val altHeld = mutableStateOf(false)
}

/**
 * In-app terminal tab: Termux `TerminalView` + `TerminalSession`.
 *
 * Transport follows the **active node** ([SettingsStore] / [NodeRosterDefaults]):
 * - **local** (`activeNodeDenUrl` is this device) → today's proot PTY via [RivetRuntime.terminalCommand]
 * - **remote** → den-server WebSocket (`/api/terminal/ws`) for that node's terminal
 *
 * Host for "escalate to terminal" — interactive bash, or a resumed agent session
 * (`claude --resume <conv>` / `grok --resume <grokSid>`). The session survives navigation.
 */
@Composable
fun TerminalPage(
    title: String = "Terminal",
    launchCommand: List<String> = listOf("/bin/bash", "-l"),
    conversationId: String? = null,
) {
    val context = LocalContext.current
    val nav = LocalNavController.current
    val settingsStore = koinInject<SettingsStore>()
    val settings by settingsStore.settingsFlow.collectAsStateWithLifecycle()
    val activeDenUrl = settings.activeNodeDenUrl.ifBlank { NodeRosterDefaults.localDenUrl() }
    val isLocal = NodeRosterDefaults.isLocalDenUrl(activeDenUrl)
    // NUL separator keeps multi-arg keys unique (same as before); den URL scopes remote sessions.
    val key = buildString {
        if (!isLocal) {
            append("remote|")
            append(NodeRosterDefaults.normalizeDenUrl(activeDenUrl))
            append('|')
        }
        append(launchCommand.joinToString("\u0000"))
    }
    // Bumped to relaunch the session (Restart after it exits).
    var restartKey by remember { mutableStateOf(0) }
    var remoteError by remember { mutableStateOf<String?>(null) }
    var remoteConnecting by remember { mutableStateOf(false) }

    // Escalating mid-turn: the GUI's bridge turn keeps streaming in the background, but a
    // `--resume` started now would snapshot the session WITHOUT it and fork on first input.
    // Gate the launch on that turn finishing instead of attaching to a stale snapshot.
    val chatService = koinInject<ChatService>()
    val inFlightTurn by remember(conversationId) {
        conversationId?.let { chatService.getGenerationJobStateFlow(Uuid.parse(it)) } ?: flowOf(null)
    }.collectAsStateWithLifecycle(initialValue = null)
    val waitingForTurn = "--resume" in launchCommand && inFlightTurn?.isActive == true

    // Surface first-run install progress and auto-attach once the rootfs is ready (local only).
    val setupProgress by RivetRuntime.setupProgress.collectAsStateWithLifecycle(initialValue = null)
    var readyTick by remember { mutableStateOf(0) }
    val rootfsReady = remember(readyTick) { RivetRuntime.isRootfsReady(context) }
    LaunchedEffect(rootfsReady, isLocal) {
        if (!isLocal || rootfsReady) return@LaunchedEffect
        // Kick off the install ourselves so progress shows the moment the terminal opens,
        // instead of waiting for the background runtime service. prepare() is idempotent and
        // lock-serialized, so this is safe even if the service runs it too.
        withContext(Dispatchers.IO) { runCatching { RivetRuntime.prepare(context) } }
        while (!RivetRuntime.isRootfsReady(context)) {
            kotlinx.coroutines.delay(500)
        }
        readyTick++
    }

    // Remote: open on a background dispatcher (HTTP spawn + WS). Local: sync acquire as before.
    // When the session key changes (active node switch / different launch argv), drop the previous
    // remote WS + FIFO bridge so it is not orphaned for the process lifetime.
    var handle by remember { mutableStateOf<TerminalHandle?>(null) }
    var previousSessionKey by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(key, restartKey, waitingForTurn, readyTick, isLocal, activeDenUrl) {
        val prevKey = previousSessionKey
        if (prevKey != null && prevKey != key) {
            // Detach-only close (WS + local FIFO). Does not DELETE the remote den PTY.
            withContext(Dispatchers.IO) { TerminalSessionStore.drop(prevKey) }
            if (handle?.key == prevKey) handle = null
        }
        previousSessionKey = key

        if (waitingForTurn) {
            handle = null
            return@LaunchedEffect
        }
        remoteError = null
        if (isLocal) {
            remoteConnecting = false
            handle = TerminalSessionStore.acquire(context, key, title, launchCommand, conversationId)
            return@LaunchedEffect
        }
        // Remote path — no rootfs required.
        remoteConnecting = true
        handle = null
        var err: String? = null
        val opened = withContext(Dispatchers.IO) {
            TerminalSessionStore.acquireRemote(
                context = context,
                key = key,
                title = title,
                denUrl = activeDenUrl,
                token = null, // roster is tokenless by design; ?token= only if we add per-node tokens later
                launchCommand = launchCommand,
                conversationId = conversationId,
                errorOut = { msg -> err = msg },
            )
        }
        handle = opened
        remoteConnecting = false
        remoteError = err ?: if (opened == null) "Remote terminal unavailable" else null
    }

    DisposableEffect(handle) {
        onDispose {
            // Keep the process / remote PTY alive across navigation — a turn running here keeps
            // running. Staleness vs. the chat GUI is handled by dropForConversation when the GUI
            // starts a bridge turn on the same conversation.
            handle?.client?.terminalView = null
        }
    }

    // Forward view resizes to the remote den PTY (local path uses forkpty ioctl already).
    val remote = if (!isLocal) TerminalSessionStore.remoteFor(key) else null

    Scaffold(
        // Ride above the soft keyboard so the keys row + terminal stay visible (Termux-style).
        modifier = Modifier.imePadding(),
        topBar = {
            TopAppBar(
                title = {
                    val t = handle?.title ?: title
                    val suffix = when {
                        handle?.finished == true -> " (ended)"
                        !isLocal -> " · remote"
                        else -> ""
                    }
                    Text(
                        text = t + suffix,
                        style = MaterialTheme.typography.titleMedium,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = { nav.popBackStack() }) {
                        Text("←", style = MaterialTheme.typography.titleLarge)
                    }
                },
            )
        },
        bottomBar = {
            if (handle != null) ExtraKeysRow(
                ctrlHeld = handle!!.ctrlHeld,
                altHeld = handle!!.altHeld,
                onSend = { bytes -> handle!!.session.write(bytes, 0, bytes.size) },
            )
        },
    ) { padding ->
        if (waitingForTurn) {
            Text(
                text = "The chat turn is still streaming — the terminal will attach to this " +
                    "session the moment it finishes.",
                modifier = Modifier.padding(padding).padding(24.dp),
            )
            return@Scaffold
        }
        if (remoteError != null && handle == null) {
            Column(
                modifier = Modifier.padding(padding).fillMaxSize().padding(24.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                Text(
                    text = remoteError!!,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error,
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    text = "Check that the active node is reachable on the mesh and that its " +
                        "den has terminals open (den.terminal / RIVETOS_DEN_TERM_OPEN).",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Spacer(Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { remoteError = null; restartKey++ }) { Text("Retry") }
                    TextButton(onClick = { nav.popBackStack() }) { Text("Back") }
                }
            }
            return@Scaffold
        }
        if (handle == null) {
            Column(
                modifier = Modifier.padding(padding).fillMaxSize().padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                CircularProgressIndicator()
                Spacer(Modifier.height(16.dp))
                Text(
                    text = when {
                        !isLocal || remoteConnecting ->
                            "Connecting to remote terminal…"
                        else -> setupProgress
                            ?: "Setting up the on-device runtime — first run can take a few minutes."
                    },
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            return@Scaffold
        }
        val activeHandle = handle!!
        Box(modifier = Modifier.padding(padding).fillMaxSize()) {
            // Key on session identity: a Restart yields a new handle → rebuilds the view.
            key(activeHandle) {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        TerminalView(ctx, null).apply {
                            setTerminalViewClient(activeHandle.client)
                            val px = (ctx.resources.displayMetrics.density * 13f).toInt()
                            setTextSize(px)
                            keepScreenOn = true
                            isFocusable = true
                            isFocusableInTouchMode = true
                            setBackgroundColor(Color.Black.toArgb())
                            activeHandle.client.terminalView = this
                            attachSession(activeHandle.session)
                            post { requestFocus() }
                        }
                    },
                    update = {
                        // Keep remote den PTY size in sync with the Termux view.
                        remote?.let { r ->
                            val emu = activeHandle.session.emulator ?: return@let
                            r.maybeResize(emu.mColumns, emu.mRows)
                        }
                    },
                )
            }
            if (activeHandle.finished) {
                Row(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .background(MaterialTheme.colorScheme.surfaceVariant)
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = remote?.errorMessage ?: "Session ended.",
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { TerminalSessionStore.drop(key); restartKey++ }) { Text("Restart") }
                    TextButton(onClick = { nav.popBackStack() }) { Text("Back to chat") }
                }
            }
        }
    }
}

/**
 * Termux-style extra-keys: CTRL/ALT are sticky modifiers (tap to arm, applies to the next
 * soft-keyboard key, auto-clears); ESC/TAB/arrows send their sequences directly.
 */
@Composable
private fun ExtraKeysRow(
    ctrlHeld: MutableState<Boolean>,
    altHeld: MutableState<Boolean>,
    onSend: (ByteArray) -> Unit,
) {
    val scroll = rememberScrollState()
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(scroll).padding(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        val esc = 27.toByte()
        val lb = '['.code.toByte()
        ModKey("CTRL", ctrlHeld.value) { ctrlHeld.value = !ctrlHeld.value }
        ModKey("ALT", altHeld.value) { altHeld.value = !altHeld.value }
        KeyCap("ESC") { onSend(byteArrayOf(esc)) }
        KeyCap("TAB") { onSend(byteArrayOf(9)) }
        KeyCap("↑") { onSend(byteArrayOf(esc, lb, 'A'.code.toByte())) }
        KeyCap("↓") { onSend(byteArrayOf(esc, lb, 'B'.code.toByte())) }
        KeyCap("←") { onSend(byteArrayOf(esc, lb, 'D'.code.toByte())) }
        KeyCap("→") { onSend(byteArrayOf(esc, lb, 'C'.code.toByte())) }
    }
}

@Composable
private fun KeyCap(label: String, onClick: () -> Unit) {
    TextButton(onClick = onClick) { Text(label) }
}

/** A sticky modifier key (CTRL/ALT): highlighted while armed. */
@Composable
private fun ModKey(label: String, active: Boolean, onClick: () -> Unit) {
    val colors = if (active) {
        ButtonDefaults.textButtonColors(
            containerColor = MaterialTheme.colorScheme.primary,
            contentColor = MaterialTheme.colorScheme.onPrimary,
        )
    } else {
        ButtonDefaults.textButtonColors()
    }
    TextButton(onClick = onClick, colors = colors) { Text(label) }
}

/**
 * Both Termux client interfaces with terminal-sane defaults. [handle] (set right after
 * construction) carries the persistent UI state + sticky modifiers; [terminalView] is
 * re-pointed each time the screen is (re)entered.
 */
internal class RivetTerminalClient : TerminalSessionClient, TerminalViewClient {

    var terminalView: TerminalView? = null
    var handle: TerminalHandle? = null

    // --- TerminalSessionClient --------------------------------------------------------
    override fun onTextChanged(changedSession: TerminalSession) { terminalView?.onScreenUpdated() }
    override fun onTitleChanged(changedSession: TerminalSession) {
        val t = changedSession.title ?: return
        if (t.isNotBlank()) handle?.title = t
    }
    override fun onSessionFinished(finishedSession: TerminalSession) {
        handle?.let { it.finished = true; TerminalSessionStore.onFinished(it.key) }
    }

    override fun onCopyTextToClipboard(session: TerminalSession, text: String?) {
        val v = terminalView ?: return
        val cm = v.context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText("rivet-terminal", text ?: ""))
    }

    override fun onPasteTextFromClipboard(session: TerminalSession?) {
        val v = terminalView ?: return
        val cm = v.context.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val paste = cm.primaryClip?.getItemAt(0)?.text?.toString() ?: return
        val bytes = paste.toByteArray(Charsets.UTF_8)
        session?.write(bytes, 0, bytes.size)
    }

    override fun onBell(session: TerminalSession) { /* no-op */ }
    override fun onColorsChanged(session: TerminalSession) { terminalView?.onScreenUpdated() }
    override fun onTerminalCursorStateChange(state: Boolean) { /* no-op */ }
    override fun getTerminalCursorStyle(): Int? = null

    // --- TerminalViewClient -----------------------------------------------------------
    override fun onScale(scale: Float): Float = scale // no pinch-zoom in v1
    override fun onSingleTapUp(e: MotionEvent?) {
        val v = terminalView ?: return
        v.requestFocus()
        val imm = v.context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(v, InputMethodManager.SHOW_IMPLICIT)
    }

    override fun shouldBackButtonBeMappedToEscape(): Boolean = false
    override fun shouldEnforceCharBasedInput(): Boolean = true
    override fun shouldUseCtrlSpaceWorkaround(): Boolean = false
    override fun isTerminalViewSelected(): Boolean = true
    override fun copyModeChanged(copyMode: Boolean) { /* no-op */ }
    override fun onKeyDown(keyCode: Int, e: KeyEvent?, session: TerminalSession?): Boolean = false
    override fun onKeyUp(keyCode: Int, e: KeyEvent?): Boolean = false
    override fun onLongPress(event: MotionEvent?): Boolean = false
    override fun readControlKey(): Boolean = handle?.ctrlHeld?.value ?: false
    override fun readAltKey(): Boolean = handle?.altHeld?.value ?: false
    override fun readShiftKey(): Boolean = false
    override fun readFnKey(): Boolean = false
    override fun onCodePoint(codePoint: Int, ctrlDown: Boolean, session: TerminalSession?): Boolean {
        // Sticky-once: a key consumed the armed modifiers, so clear them.
        handle?.let { it.ctrlHeld.value = false; it.altHeld.value = false }
        return false
    }
    override fun onEmulatorSet() { /* no-op */ }

    // --- logging (both interfaces) ----------------------------------------------------
    override fun logError(tag: String?, message: String?) { Log.e(tag ?: TAG, message ?: "") }
    override fun logWarn(tag: String?, message: String?) { Log.w(tag ?: TAG, message ?: "") }
    override fun logInfo(tag: String?, message: String?) { Log.i(tag ?: TAG, message ?: "") }
    override fun logDebug(tag: String?, message: String?) { Log.d(tag ?: TAG, message ?: "") }
    override fun logVerbose(tag: String?, message: String?) { Log.v(tag ?: TAG, message ?: "") }
    override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {
        Log.e(tag ?: TAG, message ?: "", e)
    }
    override fun logStackTrace(tag: String?, e: Exception?) { Log.e(tag ?: TAG, "", e) }
}
