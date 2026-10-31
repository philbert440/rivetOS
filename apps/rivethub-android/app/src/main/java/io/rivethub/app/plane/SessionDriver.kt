package io.rivethub.app.plane

/**
 * Chat and Terminal take turns holding a session (rh contract note 79). rh
 * says who holds it, whether a turn is running and which chat messages wait;
 * the chat shows that and lets rh's `busy` end a turn the phone still thinks
 * is running (a terminal turn, or one whose end frame never came).
 */
data class DriverState(
    /** `chat`, `terminal`, or null while neither holds the session. */
    val holder: String? = null,
    val busy: Boolean = false,
    /** Chat messages rh holds until the terminal's turn ends, oldest first. */
    val queued: List<String> = emptyList(),
)

const val DRIVER_TERMINAL = "terminal"

fun terminalHolds(d: DriverState?): Boolean = d?.holder == DRIVER_TERMINAL

/**
 * rh saw the running turn end ([prev] busy, [next] not) while the chat still
 * shows one in flight: end it here too. Only a transition counts, so a held
 * driver frame from before a send can never end the turn that send started.
 */
fun driverEndsTurn(prev: DriverState?, next: DriverState, inFlight: Boolean): Boolean =
    inFlight && prev?.busy == true && !next.busy

/** What the strip above the composer says, or null for none: the terminal holds the session. */
enum class DriverStrip { TerminalWorking, TerminalIdle }

fun driverStrip(d: DriverState?): DriverStrip? = when {
    !terminalHolds(d) -> null
    d!!.busy -> DriverStrip.TerminalWorking
    else -> DriverStrip.TerminalIdle
}
