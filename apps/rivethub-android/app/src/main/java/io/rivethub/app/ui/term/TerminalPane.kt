package io.rivethub.app.ui.term

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.os.PersistableBundle
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.TermKeys
import io.rivethub.app.plane.TermStatus
import io.rivethub.app.plane.termCellSizePx
import io.rivethub.app.plane.termColsRows
import io.rivethub.app.ui.components.KeyToolbar
import io.rivethub.app.ui.components.ToolbarKey
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

private const val IME_SENTINEL = "\u200B"
private const val RESIZE_DEBOUNCE_MS = 150L

/**
 * Full-bleed VT surface. Tap focuses and opens the IME; two-finger scroll
 * pages the local buffer. Tmux copy-mode history is out of scope.
 */
@Composable
fun TerminalPane(
    screen: AnsiScreen,
    rev: Int,
    fontSp: Int,
    status: TermStatus,
    onResize: (Int, Int) -> Unit,
    onBytes: (ByteArray) -> Unit,
    ctrl: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val density = LocalDensity.current
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val followTail = remember { mutableStateOf(true) }
    val firstLine = remember { mutableIntStateOf(0) }
    var ime by remember { mutableStateOf(TextFieldValue(IME_SENTINEL)) }
    var imeSeen by remember { mutableStateOf(IME_SENTINEL) }
    var pendingGeo by remember { mutableStateOf<Pair<Int, Int>?>(null) }
    val measurer = rememberTextMeasurer()
    val mono = TextStyle(
        fontFamily = RivetFonts.Mono,
        fontSize = fontSp.sp,
        fontWeight = FontWeight.Normal,
    )
    val measured = remember(fontSp, density.density, density.fontScale, measurer) {
        measurer.measure(AnnotatedString("M"), style = mono).size
    }
    val fallback = termCellSizePx(fontSp.toFloat(), density.density, density.fontScale)
    val cellW = measured.width.toFloat().takeIf { it > 1f } ?: fallback.first
    val cellH = measured.height.toFloat().takeIf { it > 1f } ?: fallback.second
    val appCursor = remember(rev) { screen.applicationCursor }

    LaunchedEffect(pendingGeo) {
        val g = pendingGeo ?: return@LaunchedEffect
        delay(RESIZE_DEBOUNCE_MS)
        onResize(g.first, g.second)
    }

    Box(
        modifier
            .fillMaxSize()
            .background(colors.codeBg)
            .onSizeChanged { size ->
                val geo = termColsRows(size.width.toFloat(), size.height.toFloat(), cellW, cellH)
                if (geo != null) pendingGeo = geo
            }
            .pointerInput(cellH) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var two = false
                    var moved = false
                    var lastY = down.position.y
                    while (true) {
                        val ev = awaitPointerEvent()
                        val now = ev.changes.filter { it.pressed }
                        if (now.isEmpty()) break
                        if (now.size >= 2) {
                            two = true
                            now.forEach { it.consume() }
                            val y = now.map { it.position.y }.average().toFloat()
                            val dy = lastY - y
                            if (kotlin.math.abs(dy) > 1f) {
                                moved = true
                                val delta = (dy / cellH).roundToInt()
                                if (delta != 0) {
                                    val maxFirst = (screen.lineCount - screen.rows).coerceAtLeast(0)
                                    val cur = if (followTail.value) maxFirst else firstLine.intValue.coerceIn(0, maxFirst)
                                    val next = (cur + delta).coerceIn(0, maxFirst)
                                    firstLine.intValue = next
                                    followTail.value = next >= maxFirst
                                }
                                lastY = y
                            }
                        } else if ((now[0].position - down.position).getDistance() > 24f) {
                            moved = true
                        }
                    }
                    if (!two && !moved) {
                        focus.requestFocus()
                        keyboard?.show()
                    }
                }
            },
    ) {
        val maxFirst = remember(rev) { (screen.lineCount - screen.rows).coerceAtLeast(0) }
        val first = if (followTail.value) maxFirst else firstLine.intValue.coerceIn(0, maxFirst)
        val lines = remember(rev, first, screen.rows) { screen.snapshot(first, screen.rows) }
        Canvas(Modifier.fillMaxSize()) {
            var y = 0f
            for (line in lines) {
                var x = 0f
                for (span in line.spans) {
                    val fg = spanFg(span, colors)
                    val bg = spanBg(span, colors)
                    val layout = measurer.measure(
                        AnnotatedString(span.text),
                        style = mono.copy(
                            color = fg,
                            fontWeight = if (span.bold) FontWeight.W700 else FontWeight.Normal,
                            textDecoration = if (span.underline) TextDecoration.Underline else TextDecoration.None,
                        ),
                    )
                    if (span.bg != AnsiScreen.DEFAULT_BG) {
                        drawRect(
                            color = bg,
                            topLeft = Offset(x, y),
                            size = Size(layout.size.width.toFloat(), cellH),
                        )
                    }
                    drawText(layout, topLeft = Offset(x, y))
                    x += layout.size.width
                }
                y += cellH
            }
        }
        BasicTextField(
            value = ime,
            onValueChange = { next ->
                // Diff against the last value WE saw, not against the sentinel: rapid IME commits
                // (autocorrect, paste, `input text`) arrive before the previous reset recomposes,
                // so resetting-and-resending duplicated characters. Send only the delta, once.
                val prev = imeSeen
                val cur = next.text
                val base = if (cur.startsWith(IME_SENTINEL)) IME_SENTINEL.length else 0
                var p = 0
                val max = minOf(prev.length, cur.length)
                while (p < max && prev[p] == cur[p]) p++
                val removed = (prev.length - p).coerceAtLeast(0)
                val added = if (p < cur.length) cur.substring(maxOf(p, base)) else ""
                repeat(removed.coerceAtMost(prev.length - base)) { onBytes(TermKeys.BACKSPACE) }
                if (added.isNotEmpty()) onBytes(TermKeys.ime(added.replace("\n", "\r"), ctrl))
                if (cur.length > 256 || !cur.startsWith(IME_SENTINEL)) {
                    imeSeen = IME_SENTINEL
                    ime = TextFieldValue(IME_SENTINEL)
                } else {
                    imeSeen = cur
                    ime = next
                }
            },
            modifier = Modifier
                .size(1.dp)
                .offset { IntOffset(0, 0) }
                .focusRequester(focus)
                .onPreviewKeyEvent { e ->
                    if (e.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    val bytes = when (e.key) {
                        Key.Enter, Key.NumPadEnter -> TermKeys.ENTER
                        Key.Backspace -> TermKeys.BACKSPACE
                        Key.Tab -> TermKeys.TAB
                        Key.Escape -> TermKeys.ESC
                        Key.DirectionUp -> TermKeys.up(appCursor)
                        Key.DirectionDown -> TermKeys.down(appCursor)
                        Key.DirectionLeft -> TermKeys.left(appCursor)
                        Key.DirectionRight -> TermKeys.right(appCursor)
                        else -> null
                    }
                    if (bytes != null) {
                        onBytes(bytes)
                        true
                    } else false
                },
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
            ),
            cursorBrush = SolidColor(Color.Transparent),
            textStyle = RivetType.monoTerminal.copy(color = Color.Transparent, fontSize = 1.sp),
        )
        val attachedLabel = stringResource(R.string.term_status_attached)
        val label = when (status) {
            TermStatus.Connecting -> stringResource(R.string.term_status_connecting)
            TermStatus.Attached -> attachedLabel
            TermStatus.Exited -> stringResource(R.string.term_status_exited)
            TermStatus.Closed -> stringResource(R.string.term_status_closed)
        }
        if (status != TermStatus.Attached) {
            Text(
                label,
                color = colors.inkDim,
                style = RivetType.monoPill,
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .background(colors.panel2)
                    .offset(x = Dimens.grid, y = Dimens.gridHalf),
            )
        }
    }
}

private fun spanFg(span: TermSpan, colors: io.rivethub.app.ui.theme.RivetColors): Color {
    val base = when (span.fg) {
        AnsiScreen.DEFAULT_FG -> colors.ink
        AnsiScreen.DEFAULT_BG -> colors.codeBg
        AnsiScreen.CURSOR -> colors.em
        else -> Color(span.fg)
    }
    return when {
        span.dim && span.fg == AnsiScreen.DEFAULT_FG -> colors.inkDim
        span.dim -> base.copy(alpha = 0.6f)
        else -> base
    }
}

private fun spanBg(span: TermSpan, colors: io.rivethub.app.ui.theme.RivetColors): Color = when (span.bg) {
    AnsiScreen.DEFAULT_BG -> colors.codeBg
    AnsiScreen.DEFAULT_FG -> colors.ink
    AnsiScreen.CURSOR -> colors.em
    else -> Color(span.bg)
}

@Composable
fun TerminalKeyBar(
    ctrl: Boolean,
    onCtrl: () -> Unit,
    onCtrlLock: () -> Unit,
    onBytes: (ByteArray) -> Unit,
    onPaste: () -> Unit,
    attachCommand: String?,
    onOpenInTerminal: () -> Unit,
    onDetach: () -> Unit,
    applicationCursor: Boolean = false,
    modifier: Modifier = Modifier,
) {
    var menu by remember { mutableStateOf(false) }
    val pasteCd = stringResource(R.string.cd_paste)
    val menuCd = stringResource(R.string.cd_term_menu)
    val keys = listOf(
        ToolbarKey.Label("esc", stringResource(R.string.term_esc)),
        ToolbarKey.Label("tab", stringResource(R.string.term_tab)),
        ToolbarKey.Sticky("ctrl", stringResource(R.string.term_ctrl)),
        ToolbarKey.Label("up", stringResource(R.string.term_up)),
        ToolbarKey.Label("down", stringResource(R.string.term_down)),
        ToolbarKey.Label("left", stringResource(R.string.term_left)),
        ToolbarKey.Label("right", stringResource(R.string.term_right)),
        ToolbarKey.IconAction("paste", Icons.Outlined.ContentPaste, pasteCd),
        ToolbarKey.IconAction("menu", Icons.Outlined.MoreHoriz, menuCd),
    )
    Box(modifier.fillMaxWidth()) {
        KeyToolbar(
            keys = keys,
            latched = if (ctrl) setOf("ctrl") else emptySet(),
            onKey = { key ->
                when (key.id) {
                    "esc" -> onBytes(TermKeys.ESC)
                    "tab" -> onBytes(TermKeys.TAB)
                    "ctrl" -> onCtrl()
                    "up" -> onBytes(TermKeys.up(applicationCursor))
                    "down" -> onBytes(TermKeys.down(applicationCursor))
                    "left" -> onBytes(TermKeys.left(applicationCursor))
                    "right" -> onBytes(TermKeys.right(applicationCursor))
                    "paste" -> onPaste()
                    "menu" -> menu = true
                }
            },
            onLongKey = { key ->
                if (key.id == "ctrl") onCtrlLock()
            },
        )
        DropdownMenu(
            expanded = menu,
            onDismissRequest = { menu = false },
            containerColor = RivetTheme.colors.panel,
        ) {
            if (attachCommand != null) {
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(R.string.action_open_in_terminal),
                            color = RivetTheme.colors.ink,
                            style = RivetType.body,
                        )
                    },
                    onClick = {
                        menu = false
                        onOpenInTerminal()
                    },
                )
            }
            DropdownMenuItem(
                text = {
                    Text(
                        stringResource(R.string.action_detach),
                        color = RivetTheme.colors.ink,
                        style = RivetType.body,
                    )
                },
                onClick = {
                    menu = false
                    onDetach()
                },
            )
        }
    }
}

fun clipboardText(context: Context): String? {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = cm.primaryClip ?: return null
    if (clip.itemCount == 0) return null
    return clip.getItemAt(0).coerceToText(context)?.toString()
}

fun copyText(context: Context, text: String, sensitive: Boolean = false) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clip = ClipData.newPlainText("terminal", text)
    if (sensitive && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
    }
    cm.setPrimaryClip(clip)
}
