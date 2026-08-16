package dev.rivetos.team

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.rivetos.team.domain.Persona
import dev.rivetos.team.domain.SAMPLE_USERS
import dev.rivetos.team.domain.TeamMessage
import dev.rivetos.team.domain.TeamUser
import dev.rivetos.team.gateway.GatewayEvent
import dev.rivetos.team.gateway.StubGateway
import dev.rivetos.team.ui.theme.TeamColors
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Phone-first messaging shell: person gate → roster of personas as contacts →
 * one thread. IA is the OpenMausBot / Grok Bot chat-app shape, written new
 * in Compose. Do not vendor OpenMausBot source.
 */
@Composable
fun TeamApp() {
    var user by remember { mutableStateOf<TeamUser?>(null) }
    var selected by remember { mutableStateOf<Persona?>(null) }

    val current = user
    if (current == null) {
        WhoIsThis(onPick = { user = it })
        return
    }

    if (selected == null) {
        BackHandler { user = null }
        Inbox(
            user = current,
            onOpen = { selected = it },
            onSwitchPerson = { user = null },
        )
        return
    }

    BackHandler { selected = null }
    ChatScreen(
        user = current,
        persona = selected!!,
        onBack = { selected = null },
    )
}

@Composable
private fun WhoIsThis(onPick: (TeamUser) -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(TeamColors.App)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .padding(horizontal = 20.dp, vertical = 24.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            "rivet-team",
            color = TeamColors.Em,
            fontSize = 13.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.6.sp,
        )
        Spacer(Modifier.height(10.dp))
        Text(
            "Who is this?",
            color = TeamColors.Ink,
            fontSize = 28.sp,
            fontWeight = FontWeight.SemiBold,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            "Your chats stay on this person. Switch anytime from the roster.",
            color = TeamColors.InkDim,
            fontSize = 15.sp,
        )
        Spacer(Modifier.height(28.dp))
        SAMPLE_USERS.forEach { u ->
            PersonCard(user = u, onClick = { onPick(u) })
            Spacer(Modifier.height(10.dp))
        }
    }
}

@Composable
private fun PersonCard(user: TeamUser, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(TeamColors.Card)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        InitialsMark(initials(user.displayName), TeamColors.Em)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(user.displayName, color = TeamColors.Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("@${user.handle}", color = TeamColors.InkDim, fontSize = 13.sp)
        }
        Text("Continue", color = TeamColors.Em, fontSize = 14.sp, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun Inbox(
    user: TeamUser,
    onOpen: (Persona) -> Unit,
    onSwitchPerson: () -> Unit,
) {
    val gateway = remember { StubGateway.shared }
    val personas = remember(user.id) { gateway.listPersonas(user.id) }
    var query by remember { mutableStateOf("") }
    var tick by remember { mutableIntStateOf(0) }
    val working = remember { mutableStateMapOf<String, String>() }

    DisposableEffect(user.id) {
        val closes = personas.map { p ->
            gateway.watch(p.threadId) { event ->
                when (event) {
                    is GatewayEvent.Working -> working[p.threadId] = event.label
                    GatewayEvent.Done -> working.remove(p.threadId)
                    is GatewayEvent.Message -> tick++
                }
            }
        }
        onDispose { closes.forEach { it() } }
    }

    val rows = remember(personas, query, tick, working.toMap()) {
        personas.map { p ->
            val last = gateway.sessionMessages(p.threadId).lastOrNull()
            InboxRow(
                persona = p,
                preview = working[p.threadId]
                    ?: last?.text?.replace(Regex("\\s+"), " ")?.take(72)
                    ?: p.systemPrompt.substringBefore('.').ifBlank { "Say hello" },
                time = last?.ts,
                working = working.containsKey(p.threadId),
            )
        }.filter { row ->
            val q = query.trim()
            q.isEmpty() ||
                row.persona.name.contains(q, ignoreCase = true) ||
                row.preview.contains(q, ignoreCase = true)
        }
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(TeamColors.App)
            .windowInsetsPadding(WindowInsets.safeDrawing),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 16.dp, top = 10.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                "rivet-team",
                color = TeamColors.Ink,
                fontSize = 22.sp,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
        }
        SearchField(
            value = query,
            onValue = { query = it },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp),
        )
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
        ) {
            items(rows, key = { it.persona.id }) { row ->
                ContactRow(row = row, onClick = { onOpen(row.persona) })
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .background(TeamColors.Panel)
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            InitialsMark(initials(user.displayName), TeamColors.Em, size = 36)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(user.displayName, color = TeamColors.Ink, fontSize = 14.sp, fontWeight = FontWeight.Medium)
                Text("stub · this person only", color = TeamColors.InkDim, fontSize = 12.sp)
            }
            Text(
                "Switch",
                color = TeamColors.Em,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                modifier = Modifier
                    .clip(RoundedCornerShape(8.dp))
                    .clickable(onClick = onSwitchPerson)
                    .padding(horizontal = 10.dp, vertical = 6.dp),
            )
        }
    }
}

private data class InboxRow(
    val persona: Persona,
    val preview: String,
    val time: Long?,
    val working: Boolean,
)

@Composable
private fun ContactRow(row: InboxRow, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PersonaMark(color = personaColor(row.persona.id), modifier = Modifier.size(52.dp))
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    row.persona.name,
                    color = TeamColors.Ink,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (row.time != null) {
                    Spacer(Modifier.width(8.dp))
                    Text(formatTime(row.time), color = TeamColors.InkDim, fontSize = 12.sp)
                }
            }
            Text(
                row.preview,
                color = if (row.working) TeamColors.Em else TeamColors.InkDim,
                fontSize = 13.sp,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun ChatScreen(
    user: TeamUser,
    persona: Persona,
    onBack: () -> Unit,
) {
    val gateway = remember { StubGateway.shared }
    val messages = remember(persona.threadId) { mutableStateListOf<TeamMessage>() }
    var working by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf("") }

    DisposableEffect(persona.threadId) {
        messages.clear()
        working = null
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
        val text = draft.trim()
        if (text.isEmpty()) return
        draft = ""
        gateway.postMessage(persona.threadId, text, user.id)
    }

    Column(
        Modifier
            .fillMaxSize()
            .background(TeamColors.App)
            .windowInsetsPadding(WindowInsets.safeDrawing)
            .imePadding(),
    ) {
        ChatTopBar(persona = persona, onBack = onBack)
        ThreadBody(
            messages = messages,
            working = working,
            personaName = persona.name,
            modifier = Modifier.weight(1f).fillMaxWidth(),
        )
        Composer(
            draft = draft,
            onDraft = { draft = it },
            placeholder = "Message ${persona.name}",
            onSend = { send() },
        )
    }
}

@Composable
private fun ChatTopBar(persona: Persona, onBack: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, end = 16.dp, top = 6.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "‹",
            color = TeamColors.Ink,
            fontSize = 28.sp,
            modifier = Modifier
                .clip(CircleShape)
                .clickable(onClick = onBack)
                .padding(horizontal = 12.dp, vertical = 4.dp),
        )
        PersonaMark(color = personaColor(persona.id), modifier = Modifier.size(36.dp))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(persona.name, color = TeamColors.Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
            Text("stub · local only", color = TeamColors.InkDim, fontSize = 12.sp)
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
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                PersonaMark(color = personaColor(personaName), modifier = Modifier.size(64.dp))
                Spacer(Modifier.height(14.dp))
                Text("Message $personaName", color = TeamColors.Ink, fontSize = 18.sp, fontWeight = FontWeight.Medium)
                Spacer(Modifier.height(4.dp))
                Text("Replies are stubbed this slice.", color = TeamColors.InkDim, fontSize = 13.sp)
            }
        }
        return
    }
    LazyColumn(
        modifier = modifier.padding(horizontal = 14.dp),
        state = list,
        contentPadding = PaddingValues(vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        items(messages, key = { it.id }) { m ->
            val mine = m.role == "user"
            Column(
                Modifier.fillMaxWidth(),
                horizontalAlignment = if (mine) Alignment.End else Alignment.Start,
            ) {
                Box(
                    Modifier
                        .fillMaxWidth(if (mine) 0.86f else 1f)
                        .clip(RoundedCornerShape(18.dp))
                        .background(if (mine) TeamColors.BubbleUser else TeamColors.Card)
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                ) {
                    Text(
                        m.text,
                        color = TeamColors.Ink,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                    )
                }
            }
        }
        if (working != null) {
            item("working") {
                Text(
                    working,
                    color = TeamColors.InkDim,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(start = 6.dp, top = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    placeholder: String,
    onSend: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = 12.dp, end = 12.dp, top = 6.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier
                .weight(1f)
                .clip(RoundedCornerShape(28.dp))
                .background(TeamColors.Raised)
                .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            BasicTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.weight(1f).padding(vertical = 8.dp),
                textStyle = TextStyle(color = TeamColors.Ink, fontSize = 16.sp),
                cursorBrush = SolidColor(TeamColors.Em),
                maxLines = 5,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                decorationBox = { inner ->
                    if (draft.isEmpty()) {
                        Text(placeholder, color = TeamColors.InkDim, fontSize = 16.sp)
                    }
                    inner()
                },
            )
            val canSend = draft.isNotBlank()
            Box(
                Modifier
                    .size(40.dp)
                    .clip(CircleShape)
                    .background(if (canSend) TeamColors.Em else TeamColors.Hairline)
                    .clickable(enabled = canSend, onClick = onSend),
                contentAlignment = Alignment.Center,
            ) {
                Text("↑", color = if (canSend) TeamColors.App else TeamColors.InkDim, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
            }
        }
    }
}

@Composable
private fun SearchField(
    value: String,
    onValue: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .clip(RoundedCornerShape(14.dp))
            .background(TeamColors.Inset)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("⌕", color = TeamColors.InkDim, fontSize = 16.sp)
        Spacer(Modifier.width(8.dp))
        BasicTextField(
            value = value,
            onValueChange = onValue,
            modifier = Modifier.weight(1f),
            singleLine = true,
            textStyle = TextStyle(color = TeamColors.Ink, fontSize = 15.sp),
            cursorBrush = SolidColor(TeamColors.Em),
            decorationBox = { inner ->
                if (value.isEmpty()) Text("Search", color = TeamColors.InkDim, fontSize = 15.sp)
                inner()
            },
        )
    }
}

@Composable
private fun InitialsMark(text: String, color: Color, size: Int = 48) {
    Box(
        Modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(color.copy(alpha = 0.18f)),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = color, fontWeight = FontWeight.SemiBold, fontSize = (size * 0.34f).sp)
    }
}

@Composable
private fun PersonaMark(color: Color, modifier: Modifier = Modifier) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val w = size.width
            val h = size.height
            val body = Path().apply {
                moveTo(w * 0.18f, h * 0.20f)
                lineTo(w * 0.86f, h * 0.50f)
                lineTo(w * 0.18f, h * 0.80f)
                lineTo(w * 0.34f, h * 0.50f)
                close()
            }
            drawPath(body, color)
        }
    }
}

private fun personaColor(key: String): Color {
    val palette = listOf(
        Color(0xFF34D399),
        Color(0xFF60A5FA),
        Color(0xFFFBBF24),
        Color(0xFFF472B6),
        Color(0xFFA78BFA),
        Color(0xFFFB923C),
    )
    return palette[key.hashCode().and(0x7fffffff) % palette.size]
}

private fun initials(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    if (parts.isEmpty()) return "?"
    if (parts.size == 1) return parts[0].take(2).uppercase()
    return (parts.first().take(1) + parts.last().take(1)).uppercase()
}

private fun formatTime(ts: Long): String {
    val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
    return fmt.format(Date(ts))
}
