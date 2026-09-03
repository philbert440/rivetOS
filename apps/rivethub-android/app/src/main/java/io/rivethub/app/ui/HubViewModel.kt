package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.Prefs
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.LegacyHarnessSession
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.AgentPointers
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.ConversationFilter
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.agentRow
import io.rivethub.app.plane.applyRegistryEvent
import io.rivethub.app.plane.adopt
import io.rivethub.app.plane.chatItems
import io.rivethub.app.plane.decodePointers
import io.rivethub.app.plane.encodePointers
import io.rivethub.app.plane.enrollError
import io.rivethub.app.plane.finishRefresh
import io.rivethub.app.plane.harnessIdForAgent
import io.rivethub.app.plane.listableHarnesses
import io.rivethub.app.plane.locate
import io.rivethub.app.plane.newDraftId
import io.rivethub.app.plane.openAgent
import io.rivethub.app.plane.pinChatItems
import io.rivethub.app.plane.pointerSessionKeys
import io.rivethub.app.plane.requestRefresh
import io.rivethub.app.plane.sortLocatedByRecency
import io.rivethub.app.plane.supersedeRefresh
import io.rivethub.app.plane.RefreshLatch
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.Closeable

class HubViewModel(private val c: AppContainer) : ViewModel() {
    enum class Tab { Conversations, Agents, Nodes, Settings }

    data class DraftRow(
        val id: String,
        val nodeDenUrl: String,
        val nodeId: String,
        val nodeName: String,
        val harnessId: String?,
        val createdAt: Long,
    )

    data class InboxItem(val id: String, val text: String, val atMs: Long)

    data class UiState(
        val tab: Tab = Tab.Conversations,
        val nodes: List<NodeRef> = emptyList(),
        val items: List<LocatedChatItem> = emptyList(),
        val agents: List<AgentRow> = emptyList(),
        val filter: ConversationFilter = ConversationFilter.All,
        val query: String = "",
        val searchOpen: Boolean = false,
        val archived: Set<String> = emptySet(),
        val titleOverrides: Map<String, String> = emptyMap(),
        val loading: Boolean = false,
        val error: String? = null,
        val errorKind: EnrollErrorKind? = null,
        val nodeErrors: Map<String, String> = emptyMap(),
        val inbox: List<InboxItem> = emptyList(),
        val inboxOpen: Boolean = false,
        val prefs: Prefs = Prefs(),
        val identityGen: Int = 0,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val pointers = AgentPointers()
    private var pointersLoaded = false
    private val drafts = ArrayList<DraftRow>()
    private val plane = HashMap<String, HashMap<String, Result<List<HarnessSessionSummary>>>>()
    private val legacy = HashMap<String, Result<List<LegacyHarnessSession>>>()
    private val descriptors = HashMap<String, List<HarnessDescriptor>>()
    private val watches = HashMap<String, Closeable>()
    private var refreshLatch = RefreshLatch()
    private var refreshJob: Job? = null
    private val registryFrames = Channel<RegistryMail>(Channel.UNLIMITED)

    private data class RegistryMail(val nodeUrl: String, val event: HarnessEvent, val identityGen: Int)

    init {
        viewModelScope.launch {
            for (mail in registryFrames) onRegistry(mail.nodeUrl, mail.event, mail.identityGen)
        }
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                c.setStrictHostnames(p.strictHostnames)
                loadPointers(p)
                val filter = when {
                    p.viewNodeId.isNotBlank() ->
                        _state.value.nodes.find { it.id == p.viewNodeId }?.let {
                            ConversationFilter.Node(it.id, it.name.ifBlank { it.id })
                        } ?: _state.value.filter
                    _state.value.filter is ConversationFilter.Node -> ConversationFilter.All
                    else -> _state.value.filter
                }
                _state.update {
                    it.copy(
                        prefs = p,
                        archived = p.archived,
                        titleOverrides = p.titleOverrides,
                        identityGen = c.identity.generation(),
                        filter = filter,
                    )
                }
            }
        }
        refresh()
    }

    fun setTab(tab: Tab) {
        val prev = _state.value.tab
        _state.update { it.copy(tab = tab) }
        if (tab == Tab.Conversations && prev != Tab.Conversations) refresh()
    }
    fun setFilter(filter: ConversationFilter) {
        _state.update { it.copy(filter = filter) }
        val nodeId = (filter as? ConversationFilter.Node)?.id ?: ""
        viewModelScope.launch { c.settings.setViewNodeId(nodeId) }
    }
    fun setQuery(q: String) = _state.update { it.copy(query = q) }
    fun setSearchOpen(open: Boolean) = _state.update { it.copy(searchOpen = open, query = if (open) it.query else "") }
    fun setInboxOpen(open: Boolean) = _state.update { it.copy(inboxOpen = open) }

    fun selectViewNode(node: NodeRef) {
        _state.update { it.copy(filter = ConversationFilter.Node(node.id, node.name.ifBlank { node.id }), tab = Tab.Conversations) }
        viewModelScope.launch { c.settings.setViewNodeId(node.id) }
    }

    fun archive(key: String) {
        viewModelScope.launch { c.settings.archive(key) }
    }
    fun unarchive(key: String) {
        viewModelScope.launch { c.settings.unarchive(key) }
    }
    fun rename(key: String, title: String) {
        viewModelScope.launch { c.settings.setTitleOverride(key, title) }
    }

    fun discardDraft(id: String) {
        drafts.removeAll { it.id == id }
        val pinned = pointers.all().entries.find { it.value.sessionId == id }?.key
        if (pinned != null) pointers.clear(pinned)
        viewModelScope.launch { persistPointers() }
        rebuildItems()
    }

    fun pinnedKeys(): Set<String> = pointerSessionKeys(pointers)

    fun newConversation(): AgentOpen {
        val st = _state.value
        val agent = st.agents.find { it.agentId == st.prefs.currentAgentId } ?: st.agents.firstOrNull()
        if (agent != null) {
            val open = openAgent(pointers, agent.agentId, agent.nodeDenUrl, agent.harnessId, AgentAction.Plus)
                .copy(model = agent.model, effort = agent.effort)
            if (open.draft) addDraft(open, agent.nodeId, agent.nodeName)
            viewModelScope.launch { persistPointers() }
            return open
        }
        val node = st.nodes.firstOrNull { it.denUrl == st.prefs.entryUrl } ?: st.nodes.firstOrNull()
            ?: NodeRef(hostOfUrl(st.prefs.entryUrl), hostOfUrl(st.prefs.entryUrl), st.prefs.entryUrl, true)
        val id = newDraftId()
        val open = AgentOpen(id, node.denUrl, null, draft = true, pinMoved = false)
        addDraft(open, node.id, node.name)
        return open
    }

    fun openAgentAction(row: AgentRow, action: AgentAction): AgentOpen {
        val open = openAgent(pointers, row.agentId, row.nodeDenUrl, row.harnessId, action)
            .copy(model = row.model, effort = row.effort)
        if (open.draft) addDraft(open, row.nodeId, row.nodeName)
        viewModelScope.launch {
            c.settings.setCurrentAgentId(row.agentId)
            persistPointers()
        }
        rebuildItems()
        return open
    }

    fun refresh() {
        val started = requestRefresh(refreshLatch)
        refreshLatch = started.latch
        if (!started.start) return
        refreshJob = viewModelScope.launch { refreshOnce(started.latch.gen) }
    }

    fun shutdown() {
        refreshLatch = supersedeRefresh(refreshLatch)
        refreshJob?.cancel()
        refreshJob = null
        closeWatches()
        c.dropClients()
        pointersLoaded = false
        drafts.clear()
        plane.clear()
        legacy.clear()
        descriptors.clear()
        _state.value = UiState()
    }

    override fun onCleared() {
        closeWatches()
        super.onCleared()
    }

    private fun addDraft(open: AgentOpen, nodeId: String, nodeName: String) {
        if (drafts.any { it.id == open.sessionId }) return
        drafts += DraftRow(
            id = open.sessionId,
            nodeDenUrl = open.nodeDenUrl,
            nodeId = nodeId,
            nodeName = nodeName,
            harnessId = open.harnessId,
            createdAt = System.currentTimeMillis(),
        )
        rebuildItems()
    }

    private fun loadPointers(p: Prefs) {
        if (pointersLoaded) return
        pointersLoaded = true
        for ((id, snap) in decodePointers(p.agentPointers)) {
            pointers.set(id, snap.sessionId, snap.nodeBaseUrl, replace = true)
        }
    }

    private suspend fun persistPointers() {
        c.settings.setAgentPointers(encodePointers(pointers.all()))
    }

    private suspend fun refreshOnce(gen: Int) {
        val identityGen = c.identity.generation()
        _state.update { it.copy(loading = true, error = null, errorKind = null) }
        try {
            val prefs = c.settings.snapshot()
            if (prefs.entryUrl.isBlank()) {
                _state.update { it.copy(nodes = emptyList(), items = emptyList(), agents = emptyList()) }
                return
            }
            val result = withContext(Dispatchers.IO) {
                c.transport.retarget(prefs.entryUrl, prefs.extraNodes)
                val nodes = try {
                    c.transport.discover()
                } catch (e: Exception) {
                    throw e
                }
                if (c.identity.generation() != identityGen) return@withContext null
                val presets = runCatching { c.transport.entry().agents() }.getOrNull()
                val catalog = runCatching { c.transport.entry().catalogAgents().agents }.getOrDefault(emptyList())
                coroutineScope {
                    val listed = nodes.map { node ->
                        async {
                            val hg = c.harness(node.denUrl)
                            val gw = c.transport.gateway(node)
                            val desc = runCatching { hg.listHarnesses() }
                            val planeRows = HashMap<String, Result<List<HarnessSessionSummary>>>()
                            for (hid in listableHarnesses(desc.getOrDefault(emptyList()))) {
                                planeRows[hid] = runCatching { hg.listSessions(hid) }
                            }
                            val legacyRows = runCatching { hg.legacySessions() }
                            val ok = runCatching { gw.healthz().ok }.getOrDefault(node.online)
                            val err = desc.exceptionOrNull()?.message
                                ?: planeRows.values.firstNotNullOfOrNull { it.exceptionOrNull()?.message }
                                ?: legacyRows.exceptionOrNull()?.message
                            NodeBundle(node, desc.getOrDefault(emptyList()), planeRows, legacyRows, ok, err)
                        }
                    }.awaitAll()
                    Discovered(presets, catalog, listed)
                }
            }
            if (gen != refreshLatch.gen) return
            if (result == null) return
            val (presets, catalog, listed) = result
            plane.clear()
            legacy.clear()
            descriptors.clear()
            val healthy = listed.map { b ->
                if (b.ok) b.node else b.node.copy(online = false)
            }
            val nodeErrors = LinkedHashMap<String, String>()
            for (b in listed) {
                val url = b.node.denUrl.trimEnd('/')
                descriptors[url] = b.desc
                plane[url] = HashMap(b.planeRows)
                legacy[url] = b.legacyRows
                if (b.error != null) nodeErrors[b.node.id] = b.error
            }
            val agents = buildAgents(healthy, presets, catalog)
            _state.update {
                it.copy(
                    nodes = healthy,
                    agents = agents,
                    error = null,
                    errorKind = null,
                    nodeErrors = nodeErrors,
                    identityGen = identityGen,
                )
            }
            rebuildItems()
            startWatches(healthy, identityGen)
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            if (gen != refreshLatch.gen) return
            val mapped = enrollError(e)
            _state.update {
                it.copy(
                    error = mapped.detail ?: e.message ?: e.javaClass.simpleName,
                    errorKind = mapped.kind,
                )
            }
        } finally {
            val end = finishRefresh(refreshLatch, gen)
            refreshLatch = end.latch
            _state.update { it.copy(loading = end.latch.loading) }
            if (end.rerun) refresh()
        }
    }

    private fun buildAgents(
        healthy: List<NodeRef>,
        presets: List<io.rivethub.app.gateway.AgentPreset>?,
        catalog: List<io.rivethub.app.gateway.CatalogAgent>,
    ): List<AgentRow> {
        if (presets != null) {
            return presets.mapNotNull { p ->
                val node = healthy.find { it.denUrl.trimEnd('/') == p.nodeBaseUrl.trimEnd('/') }
                    ?: healthy.find { it.id == p.id }
                    ?: healthy.firstOrNull()
                    ?: return@mapNotNull null
                val hid = p.harnessId?.takeIf { it.isNotBlank() } ?: harnessIdForAgent(p.id, null)
                agentRow(
                    p.id, p.name.ifBlank { p.id }, hid, node.id, node.name.ifBlank { node.id }, node.denUrl,
                    pointers, color = p.color, model = p.model, effort = p.effort,
                )
            }
        }
        return catalog.mapNotNull { a ->
            val node = healthy.find { it.id == a.node } ?: return@mapNotNull null
            val hid = harnessIdForAgent(a.id, a.provider)
            agentRow(a.id, a.id, hid, node.id, node.name.ifBlank { node.id }, node.denUrl, pointers)
        }
    }

    private fun startWatches(nodes: List<NodeRef>, identityGen: Int) {
        val live = nodes.map { it.denUrl.trimEnd('/') }.toSet()
        (watches.keys - live).forEach { watches.remove(it)?.close() }
        for (node in nodes) {
            val url = node.denUrl.trimEnd('/')
            if (watches.containsKey(url)) continue
            val hg = c.harness(url)
            watches[url] = hg.watchRegistry(
                onEvent = { event -> registryFrames.trySend(RegistryMail(url, event, identityGen)) },
            )
        }
    }

    private fun onRegistry(nodeUrl: String, event: HarnessEvent, identityGen: Int) {
        if (c.identity.generation() != identityGen) return
        when (event) {
            is HarnessEvent.SessionCreated -> {
                val hid = event.summary.harnessId
                val bucket = plane.getOrPut(nodeUrl) { HashMap() }
                val prev = bucket[hid]?.getOrNull()
                val next = applyRegistryEvent(prev, "session-created", event.sessionId, event.summary) ?: return
                bucket[hid] = Result.success(next)
                val hit = drafts.find { adopt(it.id, event.summary) != null }
                if (hit != null) {
                    val rekey = adopt(hit.id, event.summary)
                    if (rekey != null) {
                        drafts.removeAll { it.id == hit.id }
                        pointers.rekey(rekey.from, rekey.to)
                        viewModelScope.launch {
                            persistPointers()
                            c.settings.rekeySessionMode(rekey.from, rekey.to)
                        }
                    }
                }
                rebuildItems()
            }
            is HarnessEvent.SessionUpdated -> {
                val buckets = plane[nodeUrl] ?: return
                var changed = false
                for ((hid, result) in buckets.toList()) {
                    val list = result.getOrNull() ?: continue
                    val next = applyRegistryEvent(
                        list,
                        "session-updated",
                        event.sessionId,
                        previousSessionId = event.previousSessionId,
                        status = event.status,
                    ) ?: continue
                    if (next !== list) {
                        buckets[hid] = Result.success(next)
                        changed = true
                    }
                }
                val prev = event.previousSessionId
                if (prev != null && prev != event.sessionId) {
                    pointers.rekey(prev, event.sessionId)
                    viewModelScope.launch {
                        persistPointers()
                        c.settings.rekeySessionMode(prev, event.sessionId)
                    }
                }
                if (changed) rebuildItems()
            }
            else -> Unit
        }
    }

    private fun rebuildItems() {
        val located = ArrayList<LocatedChatItem>()
        val seen = HashSet<String>()
        val agents = _state.value.agents
        for (node in _state.value.nodes) {
            val url = node.denUrl.trimEnd('/')
            seen += url
            val desc = descriptors[url]
            val planeRows = (desc?.let { listableHarnesses(it) } ?: plane[url]?.keys.orEmpty()).associateWith { hid ->
                plane[url]?.get(hid) ?: Result.success(emptyList())
            }
            val nodeDrafts = drafts.filter { it.nodeDenUrl.trimEnd('/') == url }
            val pins = pinChatItems(pointers.all(), agents, node.denUrl)
            val items = chatItems(
                planeRows,
                legacy[url]?.getOrDefault(emptyList()) ?: emptyList(),
                nodeDrafts.map { it.id },
                nodeDrafts.associate { it.id to it.createdAt },
                pins,
            )
            for (item in items) located += locate(item, node.id, node.name.ifBlank { node.id }, node.denUrl)
        }
        for (d in drafts) {
            if (d.nodeDenUrl.trimEnd('/') in seen) continue
            val pins = pinChatItems(pointers.all(), agents, d.nodeDenUrl)
            val items = chatItems(emptyMap(), emptyList(), listOf(d.id), mapOf(d.id to d.createdAt), pins)
            for (item in items) located += locate(item, d.nodeId, d.nodeName, d.nodeDenUrl)
        }
        _state.update { it.copy(items = sortLocatedByRecency(located)) }
    }

    private fun closeWatches() {
        watches.values.forEach { it.close() }
        watches.clear()
    }

    private data class NodeBundle(
        val node: NodeRef,
        val desc: List<HarnessDescriptor>,
        val planeRows: Map<String, Result<List<HarnessSessionSummary>>>,
        val legacyRows: Result<List<LegacyHarnessSession>>,
        val ok: Boolean,
        val error: String?,
    )

    private data class Discovered(
        val presets: List<io.rivethub.app.gateway.AgentPreset>?,
        val catalog: List<io.rivethub.app.gateway.CatalogAgent>,
        val listed: List<NodeBundle>,
    )
}
