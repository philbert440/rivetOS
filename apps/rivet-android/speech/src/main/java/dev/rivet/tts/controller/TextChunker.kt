package dev.rivet.tts.controller

/**
 * Split long text into speakable chunks with basic punctuation-aware grouping.
 */
class TextChunker(
    private val maxChunkLength: Int = 150
) {
    fun split(text: String, language: String? = null): List<TtsChunk> {
        if (text.isBlank()) return emptyList()

        val paragraphs = text.split("\n\n")
        val punctuationRegex = "(?<=[。！？，、：;.!?:,\n])".toRegex()

        val chunks = paragraphs.flatMap { paragraph ->
            if (paragraph.isBlank()) emptyList() else {
                paragraph
                    .split(punctuationRegex)
                    .asSequence()
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .fold(mutableListOf<StringBuilder>()) { acc, seg ->
                        if (acc.isEmpty() || acc.last().length + seg.length > maxChunkLength) {
                            acc.add(StringBuilder(seg))
                        } else {
                            acc.last().append(seg)
                        }
                        acc
                    }
                    .map { it.toString() }
            }
        }

        return chunks.mapIndexed { index, value ->
            TtsChunk(text = value, index = index, language = language)
        }
    }
}

data class TtsChunk(
    val id: java.util.UUID = java.util.UUID.randomUUID(),
    val index: Int,
    val text: String,
    /** BCP-47 language hint for this chunk, carried through to the provider. Null = provider default. */
    val language: String? = null
)

