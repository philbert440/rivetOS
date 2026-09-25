package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn

/**
 * Phone-measured reasoning time for one assistant turn (UX-SPEC §1.3).
 *
 * The wire carries no per-turn timestamps, so the phone times it: the span
 * opens on the first reasoning delta of a turn and closes on the first thing
 * that is not reasoning — an assistant-text delta, a tool call, or
 * turn-complete, whichever comes first. The result lives in memory only; a
 * turn loaded from disk has no measurement and shows its reasoning without a
 * duration.
 */
data class ReasoningSpan(val startMs: Long, val endMs: Long?)

/** Opens the span on the first reasoning of a turn. An existing span (open or closed) is kept. */
fun ReasoningSpan?.onReasoningDelta(nowMs: Long): ReasoningSpan =
    this ?: ReasoningSpan(startMs = nowMs, endMs = null)

/** Closes an open span. A closed span keeps its first end; no span stays null. */
fun ReasoningSpan?.onFirstNonReasoning(nowMs: Long): ReasoningSpan? = when {
    this == null -> null
    endMs != null -> this
    else -> copy(endMs = nowMs.coerceAtLeast(startMs))
}

/** Elapsed ms: to the end when closed, else to [nowMs] (the live tick). */
fun ReasoningSpan.elapsedMs(nowMs: Long): Long =
    ((endMs ?: nowMs) - startMs).coerceAtLeast(0L)

/**
 * One-decimal seconds, rounded half-up on whole milliseconds ("3.4s").
 * Integer arithmetic so the output never depends on the device locale.
 */
fun reasoningSeconds(ms: Long): String {
    val tenths = (ms.coerceAtLeast(0L) + 50L) / 100L
    return "${tenths / 10}.${tenths % 10}s"
}

/**
 * "Reasoned for 3.4s" for a span. [template] receives the seconds text and
 * supplies the words, so the copy lives in string resources.
 */
fun reasoningLabel(span: ReasoningSpan, nowMs: Long, template: (String) -> String): String =
    template(reasoningSeconds(span.elapsedMs(nowMs)))

/** Same label for a stored measurement. */
fun reasoningLabelMs(durationMs: Long, template: (String) -> String): String =
    template(reasoningSeconds(durationMs))

/** Once reasoning has ended the live step folds down to its one-line label. */
fun autoCollapse(span: ReasoningSpan?): Boolean = span?.endMs != null

/**
 * One publish of the live turn folded into the clock.
 *
 * [span] is the next clock value; [finishedMs] is non-null exactly once per
 * turn, on the publish where the turn stops being in flight and a span was
 * measured — the owner files it against the finished turn.
 */
data class ReasoningStep(val span: ReasoningSpan?, val finishedMs: Long?, val turnStarted: Boolean)

/**
 * State-derived clock advance, run on every publish of the live slot. Covers
 * stores whose live turn arrives as transcript frames rather than reasoning
 * deltas, and is idempotent next to the per-frame hooks.
 *
 * - a turn starting (not in flight → in flight) forgets the previous span;
 * - reasoning seen with no text/tool yet opens the span (never after text:
 *   a span first seen mid-answer would under-report, so none is shown);
 * - text, a tool, or the turn ending closes it.
 */
fun advanceReasoning(
    span: ReasoningSpan?,
    nowMs: Long,
    wasInFlight: Boolean,
    inFlight: Boolean,
    reasoningSeen: Boolean,
    nonReasoningSeen: Boolean,
): ReasoningStep {
    val started = !wasInFlight && inFlight
    var s = if (started) null else span
    if (s == null && inFlight && reasoningSeen && !nonReasoningSeen) s = s.onReasoningDelta(nowMs)
    if (nonReasoningSeen || !inFlight) s = s.onFirstNonReasoning(nowMs)
    val finished = if (wasInFlight && !inFlight) s?.let { it.elapsedMs(nowMs) } else null
    return ReasoningStep(span = s, finishedMs = finished, turnStarted = started)
}

/** Default "this stored turn carries reasoning" test: a non-blank `thinking`. */
val HAS_THINKING: (HarnessTranscriptTurn) -> Boolean = { !it.thinking.isNullOrBlank() }

private fun isUser(t: HarnessTranscriptTurn) = t.role.equals("user", ignoreCase = true)
private fun isAssistant(t: HarnessTranscriptTurn) = t.role.equals("assistant", ignoreCase = true)

/**
 * The assistant run a turn produced: the first assistant turn at or after
 * [fromIndex] through the last assistant before the next user turn. Null
 * until an assistant is on disk there.
 */
fun assistantRun(turns: List<HarnessTranscriptTurn>, fromIndex: Int): IntRange? {
    val from = fromIndex.coerceAtLeast(0)
    var first = -1
    for (i in from until turns.size) {
        if (isAssistant(turns[i])) { first = i; break }
    }
    if (first < 0) return null
    var last = first
    for (i in first + 1 until turns.size) {
        val t = turns[i]
        if (isUser(t)) break
        if (isAssistant(t)) last = i
    }
    return first..last
}

/**
 * Which stored turn a finished measurement belongs to: inside the assistant
 * run at or after [fromIndex] (it stops at the next user turn, so a later
 * turn's reasoning is never taken), the first turn that carries reasoning,
 * else the run's first assistant. Null until that turn is on disk.
 */
fun reasoningOwnerIndex(
    turns: List<HarnessTranscriptTurn>,
    fromIndex: Int,
    hasReasoning: (HarnessTranscriptTurn) -> Boolean = HAS_THINKING,
): Int? {
    val run = assistantRun(turns, fromIndex) ?: return null
    for (i in run) {
        val t = turns[i]
        if (isAssistant(t) && hasReasoning(t)) return i
    }
    return run.first
}

/** A finished measurement waiting for its turn on disk; [from] = committed size when that turn began. */
data class PendingReasoning(val ms: Long, val from: Int)

/** Measurements kept while their turns are not on disk; older ones fall off. */
const val PENDING_REASONING_MAX: Int = 8

/**
 * Reasoning clock for a chat, owned by the view model and fed only sampled
 * times (no timers here).
 *
 * [span] is the live turn's span; [from] is the committed size when that
 * turn began (its owner key); [filed] means there is no open measurement —
 * no turn has started yet, or the live turn's span is final (queued, or
 * nothing was measured) — so stray reasoning frames cannot open one before
 * [startTurn]. [pending] holds finished measurements, oldest first,
 * until [settle] finds their turns on disk. [settledUpTo] is the last
 * transcript index of the newest assistant run already given a measurement;
 * it only moves forward, so a measurement settled in a later call can never
 * take a run an earlier call already handed out.
 *
 * Starting a turn always files the previous span first, so a queued send
 * that begins the next turn in the same frame as turn-complete cannot erase
 * the measurement the user just watched.
 */
data class ReasoningLedger(
    val span: ReasoningSpan? = null,
    val from: Int = 0,
    val filed: Boolean = true,
    val pending: List<PendingReasoning> = emptyList(),
    val settledUpTo: Int = -1,
)

/** Closes the live span and queues its duration against [ReasoningLedger.from]. Idempotent per turn. */
fun ReasoningLedger.fileSpan(nowMs: Long): ReasoningLedger {
    if (filed) return this
    val closed = span.onFirstNonReasoning(nowMs) ?: return copy(filed = true)
    val next = (pending + PendingReasoning(closed.elapsedMs(nowMs), from)).takeLast(PENDING_REASONING_MAX)
    return copy(span = closed, filed = true, pending = next)
}

/** A new turn: file the previous span, then start clean keyed on [committedSize]. */
fun ReasoningLedger.startTurn(nowMs: Long, committedSize: Int): ReasoningLedger =
    fileSpan(nowMs).copy(span = null, filed = false, from = committedSize)

/** A reasoning delta opens the span (once); ignored once the turn is filed. */
fun ReasoningLedger.reasoningDelta(nowMs: Long): ReasoningLedger =
    if (filed) this else copy(span = span.onReasoningDelta(nowMs))

/** Text or a tool call closes the span without filing it (the turn is still running). */
fun ReasoningLedger.nonReasoning(nowMs: Long): ReasoningLedger =
    if (filed) this else copy(span = span.onFirstNonReasoning(nowMs))

/**
 * One publish of the live slot, as [advanceReasoning] but on the ledger: a
 * turn starting (not in flight -> in flight) files the old span and resets;
 * the turn ending (in flight -> not) files the span.
 */
fun ReasoningLedger.advance(
    nowMs: Long,
    wasInFlight: Boolean,
    inFlight: Boolean,
    reasoningSeen: Boolean,
    nonReasoningSeen: Boolean,
    committedSize: Int,
): ReasoningLedger {
    val l = if (!wasInFlight && inFlight) startTurn(nowMs, committedSize) else this
    if (l.filed) return l
    val step = advanceReasoning(
        span = l.span,
        nowMs = nowMs,
        wasInFlight = true,
        inFlight = inFlight,
        reasoningSeen = reasoningSeen,
        nonReasoningSeen = nonReasoningSeen,
    )
    val moved = l.copy(span = step.span)
    return if (wasInFlight && !inFlight) moved.fileSpan(nowMs) else moved
}

/** [durations] = newly owned measurements by transcript index. */
data class ReasoningSettle(val ledger: ReasoningLedger, val durations: Map<Int, Long>)

/**
 * Hands pending measurements to their stored turns, oldest first. Each
 * owner is searched from its own turn start and after every run already
 * handed out — in this call or an earlier one ([ReasoningLedger.settledUpTo])
 * — so two finished turns never share one. A run is taken only once it is
 * closed — a user turn follows it (the next turn's bubble, optimistic or
 * stored) or no turn is in flight — so a later reasoning turn in the same
 * run is not missed. Two user turns before the run mean that turn never got
 * a reply on disk (aborted): its measurement is dropped. Settling stops at
 * the first measurement whose turn has not landed. The live turn's [from]
 * moves past the runs handed out, since its own reply comes after them.
 *
 * The cursor is never moved back: a transcript that shrinks under it leaves
 * later measurements unsettled (they age out of [PENDING_REASONING_MAX])
 * rather than handing them to a run that already has one.
 */
fun ReasoningLedger.settle(
    turns: List<HarnessTranscriptTurn>,
    inFlight: Boolean,
    hasReasoning: (HarnessTranscriptTurn) -> Boolean = HAS_THINKING,
): ReasoningSettle {
    if (pending.isEmpty()) return ReasoningSettle(this, emptyMap())
    val out = LinkedHashMap<Int, Long>()
    var after = settledUpTo
    var consumed = 0
    for (p in pending) {
        val start = maxOf(p.from, after + 1).coerceAtLeast(0)
        val run = assistantRun(turns, start) ?: break
        val closed = !inFlight || (run.last + 1 until turns.size).any { isUser(turns[it]) }
        if (!closed) break
        val usersBefore = (start until run.first).count { isUser(turns[it]) }
        consumed++
        if (usersBefore >= 2) continue
        out[reasoningOwnerIndex(turns, run.first, hasReasoning) ?: run.first] = p.ms
        after = run.last
    }
    if (consumed == 0) return ReasoningSettle(this, emptyMap())
    val next = copy(pending = pending.drop(consumed), settledUpTo = after, from = maxOf(from, after + 1))
    return ReasoningSettle(next, out)
}
