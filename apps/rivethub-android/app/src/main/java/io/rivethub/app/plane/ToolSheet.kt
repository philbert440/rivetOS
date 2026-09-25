package io.rivethub.app.plane

import io.rivethub.app.gateway.HarnessTranscriptTurn
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Timeline key of the in-flight turn; stored turns use their transcript index. */
const val LIVE_TURN_INDEX: Int = -1

/**
 * What an open tool detail sheet is showing, by identity rather than by
 * position: [turn] is a stored index or [LIVE_TURN_INDEX]; [liveGen] is the
 * live-turn generation it was opened on; [id] is the `toolCallId` when
 * known (a live id-less call adopts the id its result binds, see
 * [applyToolResult]); [seq] is the call's ingestion sequence within its turn
 * — the live tool list only ever appends within one generation, so
 * (generation, [seq]) names one call for the whole turn; [shown] is the last
 * step resolved for it. A stored id-less call has no identity the wire can
 * prove (no turn ids; equal content is not ownership), so its [shown] is the
 * tap-time snapshot and is never re-resolved.
 */
data class ToolSheetTarget(
    val turn: Int,
    val liveGen: Long,
    val id: String?,
    val seq: Int,
    val shown: CotStep.Tool,
)

/** A call's identity without its result: what matches a live id-less call at its sequence. */
data class ToolCallKey(val name: String, val args: JsonObject?, val input: JsonElement?)

fun toolCallKey(t: CotStep.Tool): ToolCallKey = ToolCallKey(t.name, t.args, t.input)

/** The target for a tap on [tool] among [turnSteps]; matched by reference so identical calls stay apart. */
fun toolSheetTarget(turn: Int, liveGen: Long, turnSteps: List<CotStep>, tool: CotStep.Tool): ToolSheetTarget {
    val tools = turnSteps.filterIsInstance<CotStep.Tool>()
    val seq = tools.indexOfFirst { it === tool }.takeIf { it >= 0 } ?: tools.indexOf(tool)
    return ToolSheetTarget(turn = turn, liveGen = liveGen, id = tool.id, seq = seq.coerceAtLeast(0), shown = tool)
}

/**
 * Re-resolves an open sheet against the current transcript.
 *
 * - Live target, same generation: the live call with the same id; an id-less
 *   target takes the call at its sequence with the same name and arguments,
 *   including once that call's result has bound an id onto it — the target
 *   then adopts the id, so the commit migration below can follow it.
 * - Otherwise, when the call has an id: its own stored turn if it still
 *   holds that id and name, else the newest stored turn that does — this is
 *   how the sheet follows a live call onto its committed turn, and a stored
 *   call across a window shift.
 * - An id-less target outside its live generation — a tap on a stored turn,
 *   or a live call whose turn ended before a result bound an id — never
 *   re-resolves: it keeps the snapshot it holds. Only the live path above and
 *   the id path refresh a sheet.
 * - Nothing matches (another turn took the live slot, or the id is gone):
 *   keep the last resolved step. A sheet only ever moves to a call proved to
 *   be the same one — by live generation + sequence + call, or by id.
 *
 * A match that has no result yet while the previous one had one keeps the
 * previous result, so the sheet does not fall back to "no result yet" while
 * the committed turn is still catching up.
 *
 * [liveTools] are the live tool steps in order; [storedTools] builds a stored
 * turn's tool steps by index (only called for the turn that matched).
 */
fun resolveToolSheet(
    target: ToolSheetTarget,
    liveGen: Long,
    liveTools: List<CotStep.Tool>,
    turns: List<HarnessTranscriptTurn>,
    storedTools: (Int) -> List<CotStep.Tool>,
): ToolSheetTarget {
    val id = target.id
    if (target.turn == LIVE_TURN_INDEX && target.liveGen == liveGen) {
        val hit = if (id != null) {
            liveTools.firstOrNull { it.id == id }
        } else {
            // Same generation + sequence + call (name and arguments); its result
            // may since have bound an id onto it (applyToolResult).
            liveTools.getOrNull(target.seq)?.takeIf { toolCallKey(it) == toolCallKey(target.shown) }
        }
        if (hit != null) return target.copy(id = id ?: hit.id, shown = carryResult(target.shown, hit))
    }
    if (id != null) {
        val name = target.shown.name
        fun holds(i: Int) = turns[i].tools.orEmpty().any { it.id == id && it.name == name }
        val own = target.turn.takeIf { it in turns.indices && holds(it) }
        val owner = own ?: turns.indices.lastOrNull { holds(it) }
        if (owner != null) {
            val tools = storedTools(owner)
            val seq = tools.indexOfFirst { it.id == id && it.name == name }
            if (seq >= 0) {
                return target.copy(turn = owner, seq = seq, shown = carryResult(target.shown, tools[seq]))
            }
        }
    }
    return target
}

private fun carryResult(prev: CotStep.Tool, next: CotStep.Tool): CotStep.Tool =
    if (next.resultText == null && prev.resultText != null) {
        next.copy(
            resultText = prev.resultText,
            resultTruncated = prev.resultTruncated,
            status = if (next.status == "running") prev.status else next.status,
        )
    } else {
        next
    }
