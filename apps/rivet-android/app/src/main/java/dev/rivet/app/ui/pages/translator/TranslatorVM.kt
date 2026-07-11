package dev.rivet.app.ui.pages.translator

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import dev.rivet.app.data.ai.GenerationHandler
import dev.rivet.app.data.datastore.Settings
import dev.rivet.app.data.datastore.SettingsStore
import java.util.Locale

private const val TAG = "TranslatorVM"

/** The two languages this realtime translator bridges. */
enum class TransLang { EN, ZH }

/** One finished utterance and its (streaming) translation, shown as a row in the conversation. */
data class TranslationTurn(
    val id: Long,
    val sourceLang: TransLang,
    val sourceText: String,
    val translatedText: String = "",
    val translating: Boolean = true,
)

/** Emitted when a translation is finalized and ready to be spoken aloud by the UI layer. */
data class SpeakRequest(
    val turnId: Long,
    val text: String,
    /** Language of [text] (the translation target), for voice selection if needed. */
    val lang: TransLang,
)

/**
 * Realtime voice-translator orchestration.
 *
 * The Composable layer owns the ASR/TTS hooks (they're @Composable). This VM owns the brain:
 * it takes each finalized utterance, detects its language, translates into the other language,
 * streams the result into the conversation, and emits a [SpeakRequest] when done. The UI feeds
 * utterances in via [onUtterance] and plays [speakRequests] through TTS.
 */
class TranslatorVM(
    private val settingsStore: SettingsStore,
    private val generationHandler: GenerationHandler,
) : ViewModel() {
    // Eagerly (not Lazily): the realtime loop reads settings.value off-UI (for the translate
    // model + providers), and the page never collects this flow — Lazily would leave it stuck
    // on the empty dummy, so translation would fail with "model not found".
    val settings: StateFlow<Settings> = settingsStore.settingsFlow
        .stateIn(viewModelScope, SharingStarted.Eagerly, Settings.dummy())

    // Whether the listen loop is active (mic on).
    private val _running = MutableStateFlow(false)
    val running: StateFlow<Boolean> = _running.asStateFlow()

    // Conversation history: finished utterances + their translations.
    private val _turns = MutableStateFlow<List<TranslationTurn>>(emptyList())
    val turns: StateFlow<List<TranslationTurn>> = _turns.asStateFlow()

    // Live interim transcript for the utterance currently being spoken into the mic.
    private val _partialSource = MutableStateFlow("")
    val partialSource: StateFlow<String> = _partialSource.asStateFlow()

    // Manual direction override; null = auto-detect per utterance.
    private val _forcedSource = MutableStateFlow<TransLang?>(null)
    val forcedSource: StateFlow<TransLang?> = _forcedSource.asStateFlow()

    val errorFlow = MutableSharedFlow<Throwable>()

    private val _speakRequests = MutableSharedFlow<SpeakRequest>(extraBufferCapacity = 8)
    val speakRequests: SharedFlow<SpeakRequest> = _speakRequests.asSharedFlow()

    private var nextId = 0L

    fun setRunning(value: Boolean) {
        _running.value = value
        if (!value) _partialSource.value = ""
    }

    fun setForcedSource(lang: TransLang?) {
        _forcedSource.value = lang
    }

    /** Live interim transcript from the ASR layer (not yet finalized). */
    fun updatePartial(text: String) {
        _partialSource.value = text
    }

    fun clearConversation() {
        _turns.value = emptyList()
        _partialSource.value = ""
    }

    /**
     * Handle one finalized utterance: append it, translate it into the opposite language while
     * streaming partials into its row, then emit a [SpeakRequest] for the finished translation.
     */
    fun onUtterance(text: String) {
        val source = text.trim()
        if (source.isBlank()) return

        val sourceLang = _forcedSource.value ?: detectLang(source)
        val target = if (sourceLang == TransLang.ZH) Locale.ENGLISH else Locale.SIMPLIFIED_CHINESE
        val targetLang = if (sourceLang == TransLang.ZH) TransLang.EN else TransLang.ZH

        val id = nextId++
        _turns.update { it + TranslationTurn(id = id, sourceLang = sourceLang, sourceText = source) }
        _partialSource.value = ""

        viewModelScope.launch {
            val result = runCatching {
                generationHandler.translateText(
                    settings = settings.value,
                    sourceText = source,
                    targetLanguage = target,
                ) { partial ->
                    _turns.update { list ->
                        list.map { if (it.id == id) it.copy(translatedText = partial) else it }
                    }
                }.collect { /* partials handled in onStreamUpdate */ }
            }

            // Mark the turn settled regardless of outcome.
            _turns.update { list ->
                list.map { if (it.id == id) it.copy(translating = false) else it }
            }

            result.onFailure { err ->
                err.printStackTrace()
                errorFlow.emit(err)
            }.onSuccess {
                val finalText = _turns.value.firstOrNull { it.id == id }?.translatedText.orEmpty()
                if (finalText.isNotBlank()) {
                    _speakRequests.emit(SpeakRequest(turnId = id, text = finalText, lang = targetLang))
                }
            }
        }
    }

    /**
     * Detect language for direction selection. Any CJK ideograph (or common CJK punctuation)
     * means the utterance is Chinese; otherwise treat it as English. Sufficient for EN↔ZH.
     */
    private fun detectLang(text: String): TransLang {
        val hasHan = text.any { ch ->
            val c = ch.code
            c in 0x4E00..0x9FFF ||   // CJK Unified Ideographs
                c in 0x3400..0x4DBF || // CJK Extension A
                c in 0xF900..0xFAFF    // CJK Compatibility Ideographs
        }
        return if (hasHan) TransLang.ZH else TransLang.EN
    }
}
