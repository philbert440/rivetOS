package dev.rivet.app.ui.pages.translator

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearWavyProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.dokar.sonner.ToastType
import me.rerere.hugeicons.HugeIcons
import me.rerere.hugeicons.stroke.Delete01
import me.rerere.hugeicons.stroke.Mic01
import me.rerere.hugeicons.stroke.Stop
import me.rerere.hugeicons.stroke.VolumeHigh
import dev.rivet.asr.ASRStatus
import dev.rivet.app.ui.components.nav.BackButton
import dev.rivet.app.ui.components.ui.permission.PermissionManager
import dev.rivet.app.ui.components.ui.permission.PermissionRecordAudio
import dev.rivet.app.ui.components.ui.permission.rememberPermissionState
import dev.rivet.app.ui.context.LocalToaster
import dev.rivet.app.ui.hooks.rememberCustomAsrState
import dev.rivet.app.ui.hooks.rememberCustomTtsState
import org.koin.androidx.compose.koinViewModel

@Composable
fun TranslatorPage(vm: TranslatorVM = koinViewModel()) {
    val toaster = LocalToaster.current

    val asr = rememberCustomAsrState()
    val tts = rememberCustomTtsState()
    val asrState by asr.state.collectAsStateWithLifecycle()
    val isSpeaking by tts.isSpeaking.collectAsStateWithLifecycle()
    val ttsAvailable by tts.isAvailable.collectAsStateWithLifecycle()

    val running by vm.running.collectAsStateWithLifecycle()
    val turns by vm.turns.collectAsStateWithLifecycle()
    val partialSource by vm.partialSource.collectAsStateWithLifecycle()
    val forcedSource by vm.forcedSource.collectAsStateWithLifecycle()

    val asrPermission = rememberPermissionState(PermissionRecordAudio)
    PermissionManager(permissionState = asrPermission)

    // Surface VM + ASR errors as toasts.
    LaunchedEffect(Unit) {
        vm.errorFlow.collect { toaster.show(it.message ?: "Translation error", type = ToastType.Error) }
    }
    LaunchedEffect(asrState.errorMessage) {
        asrState.errorMessage?.takeIf { it.isNotBlank() }?.let {
            toaster.show(it, type = ToastType.Error)
        }
    }

    // Live interim transcript -> VM (only while actively listening).
    LaunchedEffect(asrState.partial, running) {
        if (running) vm.updatePartial(asrState.partial)
    }

    // A finalized utterance arrived. Translate it — unless we're currently speaking our own
    // translation (that audio echoes back into the mic and would loop).
    var lastHandled by remember { mutableIntStateOf(asrState.committedCount) }
    LaunchedEffect(asrState.committedCount) {
        val count = asrState.committedCount
        if (count > lastHandled) {
            lastHandled = count
            val utterance = asrState.lastCommitted
            if (running && !isSpeaking && utterance.isNotBlank()) {
                vm.onUtterance(utterance)
            }
        }
    }

    // Speak finished translations in the target language, so the TTS provider doesn't read e.g.
    // Chinese with an English voice. flush=false so back-to-back turns queue instead of cutting off.
    LaunchedEffect(Unit) {
        vm.speakRequests.collect { req ->
            val bcp47 = if (req.lang == TransLang.ZH) "zh" else "en"
            if (ttsAvailable) tts.speak(req.text, flushCalled = false, language = bcp47)
        }
    }

    // Leaving the page: stop listening and reset the run flag so we don't return to a stale
    // "Stop" button with a dead mic. The ASR/TTS hooks dispose their own controllers.
    DisposableEffect(Unit) {
        onDispose {
            if (vm.running.value) {
                vm.setRunning(false)
                asr.stop()
            }
        }
    }

    fun toggle() {
        if (running) {
            vm.setRunning(false)
            asr.stop()
        } else {
            if (!asrPermission.allRequiredPermissionsGranted) {
                asrPermission.requestPermissions()
                return
            }
            // start() resets the controller's committedCount to 0, so reset our cursor to 0 too.
            // Otherwise a new session's first commit only reaches 1 and wouldn't exceed a stale
            // lastHandled (left at the previous session's count) — the utterance would be dropped.
            lastHandled = 0
            vm.setRunning(true)
            asr.start { }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Voice Translator") },
                navigationIcon = { BackButton() },
                actions = {
                    IconButton(onClick = { vm.clearConversation() }) {
                        Icon(HugeIcons.Delete01, contentDescription = "Clear")
                    }
                }
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { toggle() },
                containerColor = if (running) MaterialTheme.colorScheme.errorContainer
                else MaterialTheme.colorScheme.primaryContainer,
                contentColor = if (running) MaterialTheme.colorScheme.onErrorContainer
                else MaterialTheme.colorScheme.onPrimaryContainer,
                icon = {
                    Icon(
                        if (running) HugeIcons.Stop else HugeIcons.Mic01,
                        contentDescription = null
                    )
                },
                text = { Text(if (running) "Stop" else "Listen") },
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            DirectionSelector(
                forced = forcedSource,
                onSelect = { vm.setForcedSource(it) },
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )

            StatusBar(
                running = running,
                status = asrState.status,
                isSpeaking = isSpeaking,
                asrAvailable = asrState.isAvailable,
                ttsAvailable = ttsAvailable,
            )

            HorizontalDivider()

            val listState = rememberLazyListState()
            LaunchedEffect(turns.size, partialSource) {
                // Newest on top: keep the latest turn / live partial in view.
                listState.animateScrollToItem(0)
            }

            LazyColumn(
                state = listState,
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
                contentPadding = PaddingValues(vertical = 12.dp)
            ) {
                if (turns.isEmpty() && partialSource.isBlank()) {
                    item {
                        EmptyHint(asrAvailable = asrState.isAvailable)
                    }
                }
                if (partialSource.isNotBlank()) {
                    item(key = "partial") { PartialRow(partialSource) }
                }
                items(turns.asReversed(), key = { it.id }) { turn -> TurnCard(turn) }
            }
        }
    }
}

@Composable
private fun DirectionSelector(
    forced: TransLang?,
    onSelect: (TransLang?) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FilterChip(
            selected = forced == null,
            onClick = { onSelect(null) },
            label = { Text("Auto") },
        )
        FilterChip(
            selected = forced == TransLang.EN,
            onClick = { onSelect(TransLang.EN) },
            label = { Text("EN → 中文") },
        )
        FilterChip(
            selected = forced == TransLang.ZH,
            onClick = { onSelect(TransLang.ZH) },
            label = { Text("中文 → EN") },
        )
    }
}

@Composable
private fun StatusBar(
    running: Boolean,
    status: ASRStatus,
    isSpeaking: Boolean,
    asrAvailable: Boolean,
    ttsAvailable: Boolean,
) {
    val label = when {
        !asrAvailable -> "No realtime STT provider configured"
        isSpeaking -> "Speaking translation…"
        running && status == ASRStatus.Connecting -> "Connecting…"
        running -> "Listening…"
        status == ASRStatus.Stopping -> "Finishing…"
        else -> "Tap Listen to start"
    }
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (isSpeaking) Icon(HugeIcons.VolumeHigh, null, modifier = Modifier.size(18.dp))
            Text(
                label,
                style = MaterialTheme.typography.labelLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (running && status == ASRStatus.Listening && !isSpeaking) {
            LinearWavyProgressIndicator(modifier = Modifier.fillMaxWidth())
        }
        if (!ttsAvailable && asrAvailable) {
            Text(
                "No TTS provider configured — translations won't be spoken",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun TurnCard(turn: TranslationTurn) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
        )
    ) {
        Column(modifier = Modifier.padding(14.dp)) {
            Text(
                text = if (turn.sourceLang == TransLang.ZH) "中文" else "English",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                fontWeight = FontWeight.SemiBold,
            )
            Text(turn.sourceText, style = MaterialTheme.typography.bodyLarge)
            Spacer(Modifier.size(8.dp))
            HorizontalDivider()
            Spacer(Modifier.size(8.dp))
            Text(
                text = if (turn.sourceLang == TransLang.ZH) "English" else "中文",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.tertiary,
                fontWeight = FontWeight.SemiBold,
            )
            if (turn.translatedText.isBlank() && turn.translating) {
                Text(
                    "…",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            } else {
                Text(
                    turn.translatedText,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun PartialRow(text: String) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            HugeIcons.Mic01,
            null,
            modifier = Modifier.size(18.dp),
            tint = MaterialTheme.colorScheme.primary,
        )
        Text(
            text,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun EmptyHint(asrAvailable: Boolean) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 64.dp),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(
                HugeIcons.Mic01,
                null,
                modifier = Modifier.size(48.dp),
                tint = MaterialTheme.colorScheme.primary,
            )
            Spacer(Modifier.size(12.dp))
            Text(
                if (asrAvailable) "Tap Listen and start talking.\nEnglish ↔ 中文, translated and spoken aloud."
                else "Configure a realtime STT provider and a TTS provider\nin Settings → Speech to get started.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}
