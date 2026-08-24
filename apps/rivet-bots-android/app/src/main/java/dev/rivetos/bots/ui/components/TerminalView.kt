package dev.rivetos.bots.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.bots.ui.ComputerViewModel
import dev.rivetos.bots.ui.TermAttach
import dev.rivetos.bots.ui.theme.Dark
import dev.rivetos.bots.ui.theme.DarkDim
import dev.rivetos.bots.ui.theme.DarkInk
import dev.rivetos.bots.ui.theme.DarkPanel
import kotlin.math.max

private val TermBg = Color(0xFF0D1117)

@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun TerminalView(vm: ComputerViewModel, status: TermAttach, error: String?, rev: Int, modifier: Modifier = Modifier) {
    var fontSp by remember { mutableFloatStateOf(12f) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val list = rememberLazyListState()
    var follow by remember { mutableStateOf(true) }
    var field by remember { mutableStateOf(TextFieldValue()) }
    var lastSize by remember { mutableStateOf(0 to 0) }

    LaunchedEffect(list) {
        snapshotFlow { list.firstVisibleItemIndex to list.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
            .collect { (_, last) ->
                val total = list.layoutInfo.totalItemsCount
                follow = last == null || total == 0 || last >= total - 2
            }
    }
    LaunchedEffect(rev, follow) {
        if (follow) {
            val n = vm.screen.lineCount
            if (n > 0) list.scrollToItem(n - 1)
        }
    }

    Column(modifier.fillMaxSize().background(TermBg)) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth().pointerInput(Unit) {
            detectPinch { z -> fontSp = (fontSp * z).coerceIn(8f, 22f) }
        }) {
            val density = LocalDensity.current
            val cols = remember(maxWidth, fontSp, density) {
                val w = with(density) { maxWidth.toPx() }
                val cw = with(density) { fontSp.sp.toPx() } * 0.62f
                max(1, (w / cw).toInt())
            }
            val rows = remember(maxHeight, fontSp, density) {
                val h = with(density) { maxHeight.toPx() }
                val ch = with(density) { fontSp.sp.toPx() } * 1.25f
                max(1, (h / ch).toInt())
            }
            LaunchedEffect(cols, rows) {
                if (cols to rows != lastSize) {
                    lastSize = cols to rows
                    vm.onTermSize(cols, rows)
                }
            }
            val lines = vm.screen.lineCount
            LazyColumn(
                state = list,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 6.dp, vertical = 4.dp)
                    .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) {
                        focus.requestFocus()
                        keyboard?.show()
                    },
            ) {
                items(lines, key = { it }) { i ->
                    TermLineView(vm.screen.lineAt(i), fontSp)
                }
            }
            BasicTextField(
                value = field,
                onValueChange = { next ->
                    val prev = field.text
                    when {
                        next.text.length < prev.length -> vm.sendControl(byteArrayOf(0x7F))
                        next.text.startsWith(prev) -> vm.sendInput(next.text.substring(prev.length))
                        next.text.isNotEmpty() -> vm.sendInput(next.text)
                    }
                    field = TextFieldValue()
                },
                textStyle = TextStyle(color = Color.Transparent, fontSize = 1.sp),
                cursorBrush = SolidColor(Color.Transparent),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.None, keyboardType = KeyboardType.Ascii),
                modifier = Modifier
                    .size(1.dp)
                    .focusRequester(focus),
            )
            if (status != TermAttach.Attached) {
                Text(
                    statusLabel(status, error),
                    color = DarkDim,
                    fontSize = 11.sp,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(8.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(DarkPanel)
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
        }
        TermKeyBar(onSend = vm::sendControl)
    }
}

@Composable
private fun TermLineView(line: dev.rivetos.bots.ui.term.TermLine, fontSp: Float) {
    Text(
        buildAnnotatedString {
            for (span in line.spans) {
                withStyle(
                    SpanStyle(
                        color = Color(span.fg),
                        background = Color(span.bg),
                        fontWeight = if (span.bold) FontWeight.Bold else FontWeight.Normal,
                        fontFamily = FontFamily.Monospace,
                        fontSize = fontSp.sp,
                    ),
                ) { append(span.text) }
            }
        },
        maxLines = 1,
        softWrap = false,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun TermKeyBar(onSend: (ByteArray) -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(Dark).padding(horizontal = 8.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KeyChip("Esc") { onSend(byteArrayOf(0x1B)) }
        KeyChip("Tab") { onSend(byteArrayOf(0x09)) }
        KeyChip("Ctrl+C") { onSend(byteArrayOf(0x03)) }
        Spacer(Modifier.weight(1f))
        KeyChip("↑") { onSend("\u001b[A".toByteArray()) }
        KeyChip("↓") { onSend("\u001b[B".toByteArray()) }
        KeyChip("←") { onSend("\u001b[D".toByteArray()) }
        KeyChip("→") { onSend("\u001b[C".toByteArray()) }
    }
}

@Composable
private fun KeyChip(label: String, onClick: () -> Unit) {
    Text(
        label,
        color = DarkInk,
        fontSize = 12.sp,
        fontFamily = FontFamily.Monospace,
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(DarkPanel)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    )
}

private fun statusLabel(status: TermAttach, error: String?): String = when (status) {
    TermAttach.Idle, TermAttach.Connecting -> "connecting"
    TermAttach.Attached -> "attached"
    TermAttach.Exited -> "exited"
    TermAttach.Closed -> "closed"
    TermAttach.Disabled -> "disabled"
    TermAttach.Error -> error ?: "error"
}

/** Two-finger pinch only — single-finger scroll stays with the LazyColumn. */
private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.detectPinch(onZoom: (Float) -> Unit) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        var last = 0f
        do {
            val event = awaitPointerEvent()
            val pressed = event.changes.filter { it.pressed }
            if (pressed.size >= 2) {
                val d = (pressed[0].position - pressed[1].position).getDistance()
                if (last > 0f && d > 0f) onZoom(d / last)
                last = d
                pressed.forEach { it.consume() }
            } else {
                last = 0f
            }
        } while (pressed.isNotEmpty())
    }
}
