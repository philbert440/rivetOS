package dev.rivet.asr.providers

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.NoiseSuppressor
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import dev.rivet.asr.ASRController
import dev.rivet.asr.ASRProviderSetting
import dev.rivet.asr.ASRState
import dev.rivet.asr.ASRStatus
import dev.rivet.asr.appendAmplitude
import dev.rivet.asr.calculateRmsAmplitude
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.Collections

private const val TAG = "XAIASR"
private const val MAX_WEBSOCKET_QUEUE_BYTES = 200_000L
private const val MAX_RECONNECTS = 8
private const val MAX_PENDING_FRAMES = 50
// Flip to true to log per-frame audio + transcript text (PII) when debugging.
private const val VERBOSE = false

/**
 * xAI Speech-to-Text controller.
 *
 * Speaks xAI's proprietary streaming protocol (NOT OpenAI-Realtime): connects to
 * wss://api.x.ai/v1/stt with config in URL query params, streams raw PCM16 audio as
 * BINARY websocket frames (no base64, no setup message), and receives JSON
 * `transcript.created` / `transcript.partial` / `transcript.done` events. Smart-Turn
 * endpointing arrives via `speech_final` on the partial events.
 */
class XAIASRController(
    private val context: Context,
    private val httpClient: OkHttpClient,
    private val provider: ASRProviderSetting.XAI
) : ASRController {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val _state = MutableStateFlow(ASRState(isAvailable = true))
    override val state: StateFlow<ASRState> = _state.asStateFlow()

    private var webSocket: WebSocket? = null
    private var recorderJob: Job? = null
    private var audioRecord: AudioRecord? = null
    private var onTranscriptChange: ((String) -> Unit)? = null

    private val completedTranscripts = Collections.synchronizedList(mutableListOf<String>())
    @Volatile private var pendingText: String = ""
    // Guards against double-committing the same utterance when both a speech_final
    // partial and a transcript.done arrive for one turn.
    @Volatile private var committedThisTurn: Boolean = false
    // True only when the user explicitly stopped — distinguishes intentional close
    // from xAI ending the stream after a turn (which we transparently reconnect).
    @Volatile private var stopping: Boolean = false
    @Volatile private var reconnectAttempts: Int = 0
    @Volatile private var socketReady: Boolean = false
    private val pendingFrames = ArrayDeque<ByteArray>()
    private var aec: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null

    override fun start(onTranscriptChange: (String) -> Unit) {
        // Allow restart during Stopping teardown — block only while actively capturing.
        val st = state.value.status
        if (st == ASRStatus.Connecting || st == ASRStatus.Listening) return
        if (ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            setError("Microphone permission is required")
            return
        }

        this.onTranscriptChange = onTranscriptChange
        completedTranscripts.clear()
        pendingText = ""
        committedThisTurn = false
        stopping = false
        reconnectAttempts = 0
        socketReady = false
        synchronized(pendingFrames) { pendingFrames.clear() }
        _state.update { ASRState(status = ASRStatus.Connecting, isAvailable = true) }
        startCapture(provider)
        connect()
    }

    private fun connect() {
        pendingText = ""
        committedThisTurn = false
        val endpoint = provider.streamEndpoint()
        Log.i(TAG, "connect: $endpoint (attempt $reconnectAttempts)")
        val request = Request.Builder()
            .url(endpoint)
            .addHeader("Authorization", "Bearer ${provider.apiKey}")
            .build()

        webSocket = httpClient.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (webSocket !== this@XAIASRController.webSocket) return
                Log.i(TAG, "ws OPEN (http ${response.code}); starting recorder")
                reconnectAttempts = 0
                socketReady = true
                _state.update { it.copy(status = ASRStatus.Listening, errorMessage = null) }
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== this@XAIASRController.webSocket) return
                if (VERBOSE) Log.i(TAG, "evt: ${text.take(220)}")
                handleServerEvent(text)
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (webSocket !== this@XAIASRController.webSocket) return
                if (VERBOSE) Log.i(TAG, "evt(binary ${bytes.size}b)")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== this@XAIASRController.webSocket) return
                socketReady = false
                if (stopping) {
                    releaseRecorder()
                    finishIdle()
                } else {
                    val body = runCatching { response?.body?.string() }.getOrNull()
                    Log.w(TAG, "ws dropped http=${response?.code} msg=${response?.message} body=${body?.take(200)} (${t.message})")
                    maybeReconnect(t.message ?: "dropped")
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== this@XAIASRController.webSocket) return
                socketReady = false
                if (stopping) { releaseRecorder(); finishIdle() } else maybeReconnect("closed $code")
            }
        })
    }

    // xAI ends the STT stream after a turn / on inactivity. While the user is still
    // listening, transparently reopen so the conversation keeps flowing (no error).
    private fun maybeReconnect(reason: String) {
        if (stopping) return
        reconnectAttempts++
        if (reconnectAttempts > MAX_RECONNECTS) {
            Log.e(TAG, "giving up after $reconnectAttempts reconnects ($reason)")
            setError("xAI STT disconnected")
            return
        }
        Log.i(TAG, "reconnect #$reconnectAttempts ($reason)")
        _state.update { it.copy(status = ASRStatus.Connecting, errorMessage = null) }
        val delayMs = (250L * reconnectAttempts).coerceAtMost(2000L)
        scope.launch {
            delay(delayMs)
            if (!stopping) connect()
        }
    }

    private fun finishIdle() {
        webSocket = null
        _state.update { it.copy(status = ASRStatus.Idle, errorMessage = null) }
    }

    override fun stop() {
        stopping = true
        socketReady = false
        synchronized(pendingFrames) { pendingFrames.clear() }
        recorderJob?.cancel()
        val socket = webSocket
        if (socket != null) {
            _state.update { it.copy(status = ASRStatus.Stopping) }
            // Tell xAI we're done so it can flush a final transcript, then close.
            runCatching { socket.send(JSONObject().put("type", "audio.done").toString()) }
            scope.launch {
                delay(400)
                socket.close(1000, "stop")
                if (webSocket === socket) {
                    releaseRecorder()
                    webSocket = null
                    _state.update { it.copy(status = ASRStatus.Idle) }
                }
            }
        } else {
            releaseRecorder()
            _state.update { it.copy(status = ASRStatus.Idle) }
        }
    }

    override fun dispose() {
        stop()
        scope.cancel()
    }

    @SuppressLint("MissingPermission")
    private fun startCapture(provider: ASRProviderSetting.XAI) {
        recorderJob?.cancel()
        recorderJob = scope.launch(Dispatchers.IO) {
            val minBufferSize = AudioRecord.getMinBufferSize(
                provider.sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT
            )
            // ~100ms frames (xAI's recommended chunk granularity).
            val bufferSize = minBufferSize
                .coerceAtLeast(provider.sampleRate / 10 * 2)
                .coerceAtLeast(3200)

            val recorder = AudioRecord(
                MediaRecorder.AudioSource.VOICE_COMMUNICATION,
                provider.sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                bufferSize * 2
            )
            audioRecord = recorder
            val sessionId = recorder.audioSessionId
            runCatching { aec?.release() }; aec = null
            runCatching { noiseSuppressor?.release() }; noiseSuppressor = null
            if (AcousticEchoCanceler.isAvailable()) {
                aec = runCatching { AcousticEchoCanceler.create(sessionId)?.apply { enabled = true } }.getOrNull()
            }
            if (NoiseSuppressor.isAvailable()) {
                noiseSuppressor = runCatching { NoiseSuppressor.create(sessionId)?.apply { enabled = true } }.getOrNull()
            }
            Log.i(TAG, "AEC=${aec?.enabled == true} NS=${noiseSuppressor?.enabled == true}")

            try {
                recorder.startRecording()
                Log.i(TAG, "recorder started sr=${provider.sampleRate} buf=$bufferSize state=${recorder.recordingState}")
                val buffer = ByteArray(bufferSize)
                var frames = 0L
                while (isActive) {
                    val read = recorder.read(buffer, 0, buffer.size)
                    if (read > 0) {
                        val amplitude = calculateRmsAmplitude(buffer, read)
                        _state.update { it.copy(amplitudes = it.amplitudes.appendAmplitude(amplitude)) }
                        val frame = buffer.copyOf(read)
                        val sock = webSocket
                        if (socketReady && sock != null) {
                            drainPending(sock)
                            if (sock.queueSize() < MAX_WEBSOCKET_QUEUE_BYTES) {
                                sock.send(ByteString.of(*frame))
                                if (VERBOSE && (frames == 0L || frames % 20 == 0L)) Log.i(TAG, "sent frame #$frames ($read bytes, rms=$amplitude)")
                                frames++
                            } else {
                                Log.w(TAG, "WebSocket queue full, dropping audio frame")
                            }
                        } else {
                            synchronized(pendingFrames) {
                                pendingFrames.addLast(frame)
                                while (pendingFrames.size > MAX_PENDING_FRAMES) pendingFrames.removeFirst()
                            }
                        }
                    } else if (read < 0) {
                        throw IllegalStateException("AudioRecord read error: $read")
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Audio recording failed", e)
                setError(e.message ?: "Audio recording failed")
            } finally {
                runCatching { recorder.stop() }
                runCatching { recorder.release() }
                if (recorderJob === coroutineContext[Job]) { audioRecord = null; recorderJob = null }
            }
        }
    }

    private fun handleServerEvent(text: String) {
        val event = runCatching { JSONObject(text) }.getOrElse {
            Log.w(TAG, "Invalid xAI STT event: $text", it)
            return
        }

        when (val type = event.optString("type")) {
            "transcript.created" -> {
                _state.update { it.copy(status = ASRStatus.Listening, errorMessage = null) }
            }

            "transcript.partial" -> {
                val transcript = event.optString("text").trim()
                val turnEnd = event.optBoolean("speech_final", event.optBoolean("is_final", false))
                if (turnEnd) {
                    if (!committedThisTurn) {
                        commitUtterance(transcript)
                    }
                } else {
                    // New words mid-turn → a fresh turn is in progress.
                    committedThisTurn = false
                    pendingText = transcript
                    publishTranscript()
                }
            }

            "transcript.done" -> {
                val transcript = event.optString("text").trim().ifBlank { pendingText }
                if (!committedThisTurn) {
                    commitUtterance(transcript)
                }
            }

            "error" -> {
                val message = event.optJSONObject("error")?.optString("message")
                    ?: event.optString("message")
                setError(message.ifBlank { "xAI STT error" })
            }

            else -> Log.v(TAG, "Ignored xAI STT event: $type")
        }
    }

    private fun commitUtterance(transcript: String) {
        if (VERBOSE) Log.i(TAG, "commit utterance: \"$transcript\"")
        committedThisTurn = true
        pendingText = ""
        if (transcript.isNotBlank()) {
            completedTranscripts.add(transcript)
            _state.update {
                it.copy(
                    committedCount = it.committedCount + 1,
                    lastCommitted = transcript
                )
            }
        }
        publishTranscript()
    }

    private fun publishTranscript() {
        val full = (completedTranscripts + listOf(pendingText))
            .filter { it.isNotBlank() }
            .joinToString(" ")
        _state.update { it.copy(transcript = full, partial = pendingText, errorMessage = null) }
        scope.launch { onTranscriptChange?.invoke(full) }
    }

    private fun setError(message: String) {
        _state.update { it.copy(status = ASRStatus.Error, errorMessage = message) }
    }

    private fun drainPending(sock: WebSocket) {
        synchronized(pendingFrames) {
            while (pendingFrames.isNotEmpty() && sock.queueSize() < MAX_WEBSOCKET_QUEUE_BYTES) {
                sock.send(ByteString.of(*pendingFrames.removeFirst()))
            }
        }
    }

    private fun releaseRecorder() {
        recorderJob = null
        runCatching { aec?.release() }; aec = null
        runCatching { noiseSuppressor?.release() }; noiseSuppressor = null
        runCatching { audioRecord?.stop() }
        runCatching { audioRecord?.release() }
        audioRecord = null
    }
}

private fun ASRProviderSetting.XAI.streamEndpoint(): String {
    val base = websocketUrl.trim().trimEnd('/')
    val params = mutableListOf(
        "sample_rate=$sampleRate",
        "encoding=pcm",
        "interim_results=${if (interimResults) "true" else "false"}",
    )
    if (language.isNotBlank()) params.add("language=$language")
    val separator = if (base.contains("?")) "&" else "?"
    return "$base$separator${params.joinToString("&")}"
}
