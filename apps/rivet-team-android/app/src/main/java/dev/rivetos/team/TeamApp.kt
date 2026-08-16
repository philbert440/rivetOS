package dev.rivetos.team

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.team.domain.Persona
import dev.rivetos.team.domain.SAMPLE_USERS
import dev.rivetos.team.domain.TeamMessage
import dev.rivetos.team.domain.TeamUser
import dev.rivetos.team.gateway.GatewayEvent
import dev.rivetos.team.gateway.StubGateway

@Composable
fun TeamApp() {
    var user by remember { mutableStateOf<TeamUser?>(null) }
    if (user == null) {
        WhoIsThis(onPick = { user = it })
        return
    }

    BackHandler { user = null }

    val gateway = remember { StubGateway.shared }
    val current = user!!
    val personas = remember(current.id) { gateway.listPersonas(current.id) }
    var selected by remember(current.id) { mutableStateOf(personas.firstOrNull()) }
    val messages = remember(current.id) { mutableStateListOf<TeamMessage>() }
    var working by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }

    DisposableEffect(selected?.threadId) {
        val persona = selected
        messages.clear()
        working = null
        if (persona == null) return@DisposableEffect onDispose { }
        messages.addAll(gateway.sessionMessages(persona.threadId))
        val close = gateway.watch(persona.threadId) { event ->
            when (event) {
                is GatewayEvent.Message -> {
                    if (messages.none { it.id == event.message.id }) messages.add(event.message)
                    if (event.message.role == "assistant") working = null
                }
                is GatewayEvent.Working -> working = event.label
                GatewayEvent.Done -> working = null
            }
        }
        onDispose { close() }
    }

    fun send() {
        val p = selected ?: return
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        gateway.postMessage(p.threadId, text, current.id)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding(),
    ) {
        ChatTopBar(
            persona = selected,
            user = current,
            onSwitchPerson = { user = null },
        )
        PersonaChips(
            personas = personas,
            selected = selected,
            onSelect = { selected = it },
        )
        ThreadBody(
            messages = messages,
            working = working,
            personaName = selected?.name ?: "Persona",
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
        Composer(
            draft = draft,
            onDraft = { draft = it },
            enabled = selected != null,
            onSend = { send() },
        )
    }
}

@Composable
private fun WhoIsThis(onPick: (TeamUser) -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 24.dp, vertical = 20.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            "rivet-team",
            color = MaterialTheme.colorScheme.primary,
            style = MaterialTheme.typography.labelLarge,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Who is this?",
            color = MaterialTheme.colorScheme.onBackground,
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Your chats and notes stay on this person. Switch anytime.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
        )
        Spacer(Modifier.height(28.dp))
        SAMPLE_USERS.forEach { u ->
            PersonCard(user = u, onClick = { onPick(u) })
            Spacer(Modifier.height(12.dp))
        }
    }
}

@Composable
private fun PersonCard(user: TeamUser, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 18.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Surface(Modifier.size(48.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)) {
                Box(contentAlignment = Alignment.Center) {
                    Text(initials(user.displayName), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                }
            }
            Spacer(Modifier.width(14.dp))
            Column(Modifier.weight(1f)) {
                Text(user.displayName, color = MaterialTheme.colorScheme.onSurface, style = MaterialTheme.typography.titleMedium)
                Text("@${user.handle}", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
            }
            Text("Continue", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun ChatTopBar(persona: Persona?, user: TeamUser, onSwitchPerson: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onSwitchPerson) { Text("‹ ${user.displayName}") }
        Spacer(Modifier.weight(1f))
        Column(horizontalAlignment = Alignment.End) {
            Text(
                persona?.name ?: "Choose a persona",
                color = MaterialTheme.colorScheme.onBackground,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Medium,
            )
            Text("stub · local only", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
        }
    }
}

@Composable
private fun PersonaChips(
    personas: List<Persona>,
    selected: Persona?,
    onSelect: (Persona) -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        personas.forEach { p ->
            val active = p.id == selected?.id
            FilterChip(
                selected = active,
                onClick = { onSelect(p) },
                label = { Text(p.name) },
                colors = FilterChipDefaults.filterChipColors(
                    selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.22f),
                    selectedLabelColor = MaterialTheme.colorScheme.onBackground,
                ),
            )
        }
    }
}

@Composable
private fun ThreadBody(
    messages: List<TeamMessage>,
    working: String?,
    personaName: String,
    modifier: Modifier = Modifier,
) {
    val list = rememberLazyListState()
    LaunchedEffect(messages.size, working) {
        if (messages.isNotEmpty()) list.animateScrollToItem(messages.lastIndex)
    }
    if (messages.isEmpty() && working == null) {
        Box(modifier, contentAlignment = Alignment.Center) {
            Text(
                "Message $personaName",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        return
    }
    LazyColumn(
        modifier = modifier.padding(horizontal = 16.dp),
        state = list,
        contentPadding = PaddingValues(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(messages, key = { it.id }) { m ->
            val mine = m.role == "user"
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            ) {
                Surface(
                    shape = RoundedCornerShape(
                        topStart = 18.dp,
                        topEnd = 18.dp,
                        bottomStart = if (mine) 18.dp else 4.dp,
                        bottomEnd = if (mine) 4.dp else 18.dp,
                    ),
                    color = if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surface,
                ) {
                    Text(
                        m.text,
                        Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                        color = MaterialTheme.colorScheme.onBackground,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
        if (working != null) {
            item("working") {
                Text(
                    working,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(start = 4.dp, top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun Composer(draft: String, onDraft: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 10.dp),
        verticalAlignment = Alignment.Bottom,
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            modifier = Modifier.weight(1f),
            enabled = enabled,
            placeholder = { Text("Message") },
            maxLines = 5,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
            keyboardActions = KeyboardActions(onSend = { onSend() }),
            shape = RoundedCornerShape(22.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = MaterialTheme.colorScheme.outline,
            ),
        )
        Spacer(Modifier.width(8.dp))
        Button(
            onClick = onSend,
            enabled = enabled && draft.isNotBlank(),
            shape = CircleShape,
            modifier = Modifier.size(52.dp),
            contentPadding = PaddingValues(0.dp),
        ) {
            Text("↑", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

private fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase()
    return (parts.first().take(1) + parts.last().take(1)).uppercase()
}
