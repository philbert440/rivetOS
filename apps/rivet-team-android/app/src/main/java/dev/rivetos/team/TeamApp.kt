package dev.rivetos.team

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
        Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(24.dp)) {
            Text("Who is this?", color = MaterialTheme.colorScheme.onBackground, style = MaterialTheme.typography.titleLarge)
            Text("Each person has their own personas and memory.", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 13.sp)
            Spacer(Modifier.height(16.dp))
            SAMPLE_USERS.forEach { u ->
                Button(onClick = { user = u }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text("${u.displayName}  @${u.handle}")
                }
            }
        }
        return
    }
    val gateway = remember { StubGateway.shared }
    val personas = remember(user) { gateway.listPersonas(user!!.id) }
    var selected by remember { mutableStateOf(personas.firstOrNull()) }
    val messages = remember { mutableStateListOf<TeamMessage>() }
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

    Row(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        PersonaRail(
            personas = personas,
            selected = selected,
            onSelect = { selected = it },
            modifier = Modifier.width(220.dp).fillMaxHeight(),
        )
        Column(Modifier.weight(1f).fillMaxHeight()) {
            ThreadHeader(selected)
            ThreadBody(messages, working, Modifier.weight(1f))
            Composer(
                draft = draft,
                onDraft = { draft = it },
                enabled = selected != null,
                onSend = {
                    val p = selected ?: return@Composer
                    val text = draft.trim()
                    if (text.isEmpty()) return@Composer
                    draft = ""
                    gateway.postMessage(p.threadId, text, user!!.id)
                },
            )
        }
    }
}

@Composable
private fun PersonaRail(
    personas: List<Persona>,
    selected: Persona?,
    onSelect: (Persona) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.background(MaterialTheme.colorScheme.surface).padding(12.dp)) {
        Text("rivet-team", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.titleSmall)
        Text("Personas · one thread each", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 11.sp)
        Spacer(Modifier.height(12.dp))
        personas.forEach { p ->
            val active = p.id == selected?.id
            Row(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(10.dp))
                    .background(if (active) MaterialTheme.colorScheme.background else MaterialTheme.colorScheme.surface)
                    .clickable { onSelect(p) }
                    .padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Surface(Modifier.size(32.dp), shape = CircleShape, color = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f)) {
                    BoxCenter { Text(initials(p.name), color = MaterialTheme.colorScheme.primary, fontSize = 11.sp) }
                }
                Spacer(Modifier.width(8.dp))
                Column {
                    Text(p.name, color = MaterialTheme.colorScheme.onSurface, fontSize = 13.sp)
                    Text(
                        (if (p.sample) "sample · " else "") + p.nodeId,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontSize = 10.sp,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
        }
        Spacer(Modifier.weight(1f))
        Text("gateway stub", color = MaterialTheme.colorScheme.onSurfaceVariant, fontSize = 10.sp)
    }
}

@Composable
private fun BoxCenter(content: @Composable () -> Unit) {
    Row(Modifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.Center) {
        content()
    }
}

@Composable
private fun ThreadHeader(persona: Persona?) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text(persona?.name ?: "Select a persona", color = MaterialTheme.colorScheme.onBackground)
        if (persona != null) {
            Text(
                "one thread · bound to ${persona.nodeId}" + if (persona.sample) " · sample" else "",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontSize = 12.sp,
            )
        }
    }
}

@Composable
private fun ThreadBody(messages: List<TeamMessage>, working: String?, modifier: Modifier = Modifier) {
    val list = rememberLazyListState()
    LaunchedEffect(messages.size, working) {
        if (messages.isNotEmpty()) list.animateScrollToItem(messages.lastIndex)
    }
    LazyColumn(modifier.padding(horizontal = 16.dp), state = list, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(messages, key = { it.id }) { m ->
            val mine = m.role == "user"
            Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
                Surface(
                    shape = RoundedCornerShape(16.dp),
                    color = if (mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.18f) else MaterialTheme.colorScheme.surface,
                ) {
                    Column(Modifier.padding(12.dp)) {
                        Text(
                            "${m.role}  ${m.personaId} · ${m.nodeId}",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            fontSize = 10.sp,
                        )
                        Text(m.text, color = MaterialTheme.colorScheme.onBackground, fontSize = 14.sp)
                    }
                }
            }
        }
        if (working != null) {
            item("working") {
                Surface(shape = RoundedCornerShape(50), color = MaterialTheme.colorScheme.surface) {
                    Text(working, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

@Composable
private fun Composer(draft: String, onDraft: (String) -> Unit, enabled: Boolean, onSend: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraft,
            modifier = Modifier.weight(1f),
            enabled = enabled,
            placeholder = { Text("Message this persona…") },
        )
        Spacer(Modifier.width(8.dp))
        Button(onClick = onSend, enabled = enabled && draft.isNotBlank()) { Text("Send") }
    }
}

private fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase()
    return (parts.first().take(1) + parts.last().take(1)).uppercase()
}
