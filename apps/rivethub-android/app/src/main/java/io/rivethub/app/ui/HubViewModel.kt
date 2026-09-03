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
import io.rivethub.app.plane.FILTER_ALL
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.agentRow
import io.rivethub.app.plane.applyRegistryEvent
import io.rivethub.app.plane.adopt
import io.rivethub.app.plane.chatItems
import io.rivethub.app.plane.decodePointers
import io.rivethub.app.plane.encodePointers
import io.rivethub.app.plane.harnessIdForAgent
import io.rivethub.app.plane.listableHarnesses
import io.rivethub.app.plane.locate
import io.rivethub.app.plane.newDraftId
import io.rivethub.app.plane.openAgent
import io.rivethub.app.plane.pointerSessionKeys
import io.rivethub.app.plane.sortLocatedByRecency
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
        val filter: String = FILTER_ALL,
        val query: String = "",
        val searchOpen: Boolean = false,
        val archived: Set<String> = emptySet(),
        val titleOverrides: Map<String, String> = emptyMap(),
        val loading: Boolean = false,
        val error: String? = null,
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
    private val plane = HashMap<String, HashMap<String, List<HarnessSessionSummary>>>()
    private val legacy = HashMap<String, List<LegacyHarnessSession>>()
    private val descriptors = HashMap<String, List<HarnessDescriptor>>()
    private val watches = HashMap<String, Closeable>()
    @Volatile private var refreshGen = 0
    private var refreshAgain = false
    private var refreshJob: Job? = null

    init {
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                c.setStrictHostnames(p.strictHostnames)
                loadPointers(p)
                val filter = when {
                    p.viewNodeId.isNotBlank() ->
                        _state.value.nodes.find { it.id == p.viewNodeId }?.name ?: _state.value.filter
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

    fun setTab(tab: Tab) = _state.update { it.copy(tab = tab) }
    fun setFilter(filter: String) {
        _state.update { it.copy(filter = filter) }
        val node = _state.value.nodes.find { it.name == filter || it.id == filter }
        viewModelScope.launch { c.settings.setViewNodeId(node?.id ?: "") }
    }
    fun setQuery(q: String) = _state.update { it.copy(query = q) }
    fun setSearchOpen(open: Boolean) = _state.update { it.copy(searchOpen = open, query = if (open) it.query else "") }
    fun setInboxOpen(open: Boolean) = _state.update { it.copy(inboxOpen = open) }

    fun selectViewNode(node: NodeRef) {
        _state.update { it.copy(filter = node.name, tab = Tab.Conversations) }
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
        if (open.draft) addDraft(open, row.nodeId, row.nodeName)
        viewModelScope.launch {
            c.settings.setCurrentAgentId(row.agentId)
            persistPointers()
        }
        rebuildItems()
        return open
    }

    fun refresh() {
        if (_state.value.loading) {
            refreshAgain = true
            return
        }
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch { refreshOnce() }
    }

    fun shutdown() {
        refreshGen++
        closeWatches()
        c.dropClients()
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

    private suspend fun refreshOnce() {
        val gen = ++refreshGen
        val identityGen = c.identity.generation()
        _state.update { it.copy(loading = true, error = null) }
        try {
            val prefs = c.settings.snapshot()
            if (prefs.entryUrl.isBlank()) {
                _state.update { it.copy(loading = false, nodes = emptyList(), items = emptyList()) }
                return
            }
            val result = withContext(Dispatchers.IO) {
                c.transport.retarget(prefs.entryUrl, prefs.extraNodes)
                val nodes = c.transport.discover()
                if (c.identity.generation() != identityGen) return@withContext null
                val catalog = runCatching { c.transport.entry().catalogAgents().agents }.getOrDefault(emptyList())
                coroutineScope {
                    val listed = nodes.map { node ->
                        async {
                            val hg = c.harness(node.denUrl)
                            val gw = c.transport.gateway(node)
                            val desc = runCatching { hg.listHarnesses() }.getOrDefault(emptyList())
                            val planeRows = HashMap<String, List<HarnessSessionSummary>>()
                            for (hid in listableHarnesses(desc)) {
                                planeRows[hid] = runCatching { hg.listSessions(hid) }.getOrDefault(emptyList())
                            }
                            val legacyRows = runCatching { hg.legacySessions() }.getOrDefault(emptyList())
                            NodeBundle(node, desc, planeRows, legacyRows, runCatching { gw.healthz().ok }.getOrDefault(node.online))
                        }
                    }.awaitAll()
                    Triple(nodes, catalog, listed)
                }
            }
            if (gen != refreshGen || result == null) return
            val (nodes, catalog, listed) = result
            plane.clear()
            legacy.clear()
            descriptors.clear()
            val healthy = listed.map { b ->
                if (b.ok) b.node else b.node.copy(online = false)
            }
            for (b in listed) {
                val url = b.node.denUrl.trimEnd('/')
                descriptors[url] = b.desc
                plane[url] = HashMap(b.planeRows)
                legacy[url] = b.legacyRows
            }
            val agents = catalog.mapNotNull { a ->
                val node = healthy.find { it.id == a.node } ?: return@mapNotNull null
                val hid = harnessIdForAgent(a.id, a.provider)
                agentRow(a.id, a.id, hid, node.id, node.name.ifBlank { node.id }, node.denUrl, pointers)
            }
            _state.update {
                it.copy(
                    nodes = healthy,
                    agents = agents,
                    loading = false,
                    error = null,
                    identityGen = identityGen,
                )
            }
            rebuildItems()
            startWatches(healthy, identityGen)
        } catch (e: Exception) {
            if (gen != refreshGen) return
            _state.update { it.copy(loading = false, error = e.message ?: e.javaClass.simpleName) }
        } finally {
            if (refreshAgain && gen == refreshGen) {
                refreshAgain = false
                refresh()
            }
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
                onEvent = { event ->
                    viewModelScope.launch { onRegistry(url, event, identityGen) }
                },
            )
        }
    }

    private fun onRegistry(nodeUrl: String, event: HarnessEvent, identityGen: Int) {
        if (c.identity.generation() != identityGen) return
        when (event) {
            is HarnessEvent.SessionCreated -> {
                val hid = event.summary.harnessId
                val prev = plane.getOrPut(nodeUrl) { HashMap() }[hid]
                val next = applyRegistryEvent(prev, "session-created", event.sessionId, event.summary) ?: return
                plane.getOrPut(nodeUrl) { HashMap() }[hid] = next
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
                for ((hid, list) in buckets.toList()) {
                    val next = applyRegistryEvent(
                        list,
                        "session-updated",
                        event.sessionId,
                        previousSessionId = event.previousSessionId,
                        status = event.status,
                    ) ?: continue
                    if (next !== list) {
                        buckets[hid] = next
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
        for (node in _state.value.nodes) {
            val url = node.denUrl.trimEnd('/')
            seen += url
            val desc = descriptors[url]
            val planeRows = (desc?.let { listableHarnesses(it) } ?: plane[url]?.keys.orEmpty()).associateWith { hid ->
                Result.success(plane[url]?.get(hid) ?: emptyList())
            }
            val nodeDrafts = drafts.filter { it.nodeDenUrl.trimEnd('/') == url }
            val items = chatItems(
                planeRows,
                legacy[url] ?: emptyList(),
                nodeDrafts.map { it.id },
                nodeDrafts.associate { it.id to it.createdAt },
            )
            for (item in items) located += locate(item, node.id, node.name.ifBlank { node.id }, node.denUrl)
        }
        for (d in drafts) {
            if (d.nodeDenUrl.trimEnd('/') in seen) continue
            val items = chatItems(emptyMap(), emptyList(), listOf(d.id), mapOf(d.id to d.createdAt))
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
        val planeRows: Map<String, List<HarnessSessionSummary>>,
        val legacyRows: List<LegacyHarnessSession>,
        val ok: Boolean,
    )
}
