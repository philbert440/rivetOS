package dev.rivet.asr

enum class ASRStatus {
    Idle,
    Connecting,
    Listening,
    Stopping,
    Error
}

data class ASRState(
    val status: ASRStatus = ASRStatus.Idle,
    val isAvailable: Boolean = false,
    val transcript: String = "",
    /** Only the in-progress (not-yet-finalized) words, if the controller distinguishes them. */
    val partial: String = "",
    val errorMessage: String? = null,
    val amplitudes: List<Float> = emptyList(),
    /**
     * Monotonically increasing counter of finalized utterances. Observers can react to a
     * new committed utterance by watching this value change. Populated by streaming
     * controllers that have turn/segment boundaries (e.g. server VAD); other controllers
     * leave it at 0.
     */
    val committedCount: Int = 0,
    /** The text of the most recently finalized utterance (the one [committedCount] points at). */
    val lastCommitted: String = "",
) {
    val isRecording: Boolean
        get() = status == ASRStatus.Connecting || status == ASRStatus.Listening || status == ASRStatus.Stopping
}
