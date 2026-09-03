package io.rivethub.app.ui.term

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.rivethub.app.R
import io.rivethub.app.plane.TermKeys
import io.rivethub.app.plane.termCellSizePx
import io.rivethub.app.plane.termColsRows
import io.rivethub.app.ui.components.KeyToolbar
import io.rivethub.app.ui.components.ToolbarKey
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.RivetFonts
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import kotlin.math.roundToInt

private const val IME_SENTINEL = "\u200B"

/**
 * Full-bleed VT surface. Tap focuses and opens the IME; two-finger scroll
 * pages the local buffer. Tmux copy-mode history is out of scope.
 */
@Composable
fun TerminalPane(
    screen: AnsiScreen,
    rev: Int,
    fontSp: Int,
    status: String,
    onResize: (Int, Int) -> Unit,
    onBytes: (ByteArray) -> Unit,
    ctrl: Boolean,
    modifier: Modifier = Modifier,
) {
    val colors = RivetTheme.colors
    val density = LocalDensity.current.density
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var scrollLines by remember { mutableIntStateOf(0) }
    var ime by remember { mutableStateOf(TextFieldValue(IME_SENTINEL)) }
    val cellH = remember(fontSp, density) { termCellSizePx(fontSp.toFloat(), density).second }

    Box(
        modifier
            .fillMaxSize()
            .background(colors.codeBg)
            .onSizeChanged { size ->
                val (cw, ch) = termCellSizePx(fontSp.toFloat(), density)
                val geo = termColsRows(size.width.toFloat(), size.height.toFloat(), cw, ch)
                if (geo != null) onResize(geo.first, geo.second)
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
                                    val maxOff = (screen.lineCount - screen.rows).coerceAtLeast(0)
                                    scrollLines = (scrollLines + delta).coerceIn(0, maxOff)
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
        val maxOff = (screen.lineCount - screen.rows).coerceAtLeast(0)
        val off = scrollLines.coerceIn(0, maxOff)
        val first = (screen.lineCount - screen.rows - off).coerceAtLeast(0)
        Column(Modifier.fillMaxSize()) {
            repeat(screen.rows) { i ->
                key(rev, i) {
                    TermLineRow(
                        line = screen.lineAt(first + i),
                        fontSp = fontSp,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
        BasicTextField(
            value = ime,
            onValueChange = { next ->
                val t = next.text
                when {
                    t.isEmpty() -> onBytes(TermKeys.BACKSPACE)
                    t.startsWith(IME_SENTINEL) -> {
                        val typed = t.removePrefix(IME_SENTINEL)
                        if (typed.isNotEmpty()) onBytes(TermKeys.ime(typed, ctrl))
                    }
                    else -> {
                        if (t.isNotEmpty()) onBytes(TermKeys.ime(t, ctrl))
                    }
                }
                ime = TextFieldValue(IME_SENTINEL)
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
                        Key.DirectionUp -> TermKeys.UP
                        Key.DirectionDown -> TermKeys.DOWN
                        Key.DirectionLeft -> TermKeys.LEFT
                        Key.DirectionRight -> TermKeys.RIGHT
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
        if (status != "attached") {
            val label = when (status) {
                "connecting" -> stringResource(R.string.term_status_connecting)
                "exited" -> stringResource(R.string.term_status_exited)
                else -> stringResource(R.string.term_status_closed)
            }
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

@Composable
private fun TermLineRow(line: TermLine, fontSp: Int, modifier: Modifier = Modifier) {
    val colors = RivetTheme.colors
    val annotated = buildAnnotatedString {
        for (span in line.spans) {
            val fg = spanFg(span, colors)
            val bg = spanBg(span, colors)
            withStyle(
                SpanStyle(
                    color = fg,
                    background = bg,
                    fontWeight = if (span.bold) FontWeight.W700 else FontWeight.Normal,
                    textDecoration = if (span.underline) TextDecoration.Underline else TextDecoration.None,
                    fontFamily = RivetFonts.Mono,
                    fontSize = fontSp.sp,
                ),
            ) { append(span.text) }
        }
    }
    Text(
        annotated,
        modifier = modifier,
        fontFamily = RivetFonts.Mono,
        fontSize = fontSp.sp,
        lineHeight = (fontSp * 1.2f).sp,
        maxLines = 1,
        softWrap = false,
    )
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
    onBytes: (ByteArray) -> Unit,
    onPaste: () -> Unit,
    attachCommand: String?,
    onOpenInTerminal: () -> Unit,
    onDetach: () -> Unit,
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
                    "up" -> onBytes(TermKeys.UP)
                    "down" -> onBytes(TermKeys.DOWN)
                    "left" -> onBytes(TermKeys.LEFT)
                    "right" -> onBytes(TermKeys.RIGHT)
                    "paste" -> onPaste()
                    "menu" -> menu = true
                }
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

fun copyText(context: Context, text: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    cm.setPrimaryClip(ClipData.newPlainText("terminal", text))
}
