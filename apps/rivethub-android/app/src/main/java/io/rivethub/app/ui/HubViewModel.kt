package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.Prefs
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.LegacyHarnessSession
import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentNodeHint
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.AgentPointers
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.plane.ConversationFilter
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.applyRegistryEvent
import io.rivethub.app.plane.adopt
import io.rivethub.app.plane.buildAgents
import io.rivethub.app.plane.chatItems
import io.rivethub.app.plane.decodePointers
import io.rivethub.app.plane.encodePointers
import io.rivethub.app.plane.enrollError
import io.rivethub.app.plane.finishRefresh
import io.rivethub.app.plane.listableHarnesses
import io.rivethub.app.plane.locate
import io.rivethub.app.plane.newDraftId
import io.rivethub.app.plane.openAgent
import io.rivethub.app.plane.pinChatItems
import io.rivethub.app.plane.pointerSessionKeys
import io.rivethub.app.plane.rekeyPinnedDraft
import io.rivethub.app.plane.requestRefresh
import io.rivethub.app.plane.sortLocatedByRecency
import io.rivethub.app.plane.supersedeRefresh
import io.rivethub.app.plane.RefreshLatch
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.transport.hostOfUrl
import io.rivethub.app.plane.NODE_BUNDLE_TIMEOUT_MS
import io.rivethub.app.plane.fetchAfterHealthz
import io.rivethub.app.plane.fetchBundlesProgressively
import io.rivethub.app.plane.nodeErrorBadge
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable

class HubViewModel(private val c: AppContainer) : ViewModel() {
    enum class Tab { Conversations, Settings }

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
        val discoveringDone: Int = 0,
        val discoveringTotal: Int = 0,
        val inbox: List<InboxItem> = emptyList(),
        val inboxOpen: Boolean = false,
        val prefs: Prefs = Prefs(),
        val identityGen: Int = 0,
        val registryOpen: Boolean = false,
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

    fun selectViewNode(node: NodeRef) = selectViewNode(node.id, node.name.ifBlank { node.id })

    fun selectViewNode(nodeId: String, nodeName: String) {
        val already = _state.value.prefs.viewNodeId == nodeId
        if (already) {
            _state.update { it.copy(filter = ConversationFilter.All, tab = Tab.Conversations) }
            viewModelScope.launch { c.settings.setViewNodeId("") }
        } else {
            _state.update {
                it.copy(
                    filter = ConversationFilter.Node(nodeId, nodeName),
                    tab = Tab.Conversations,
                )
            }
            viewModelScope.launch { c.settings.setViewNodeId(nodeId) }
        }
    }

    fun setAgentsCollapsed(collapsed: Boolean) {
        viewModelScope.launch { c.settings.setAgentsCollapsed(collapsed) }
    }

    fun removeSavedNode(url: String) {
        viewModelScope.launch {
            c.settings.removeExtraNode(url)
            val st = _state.value
            val hit = st.nodes.find { it.denUrl.trimEnd('/') == url.trim().trimEnd('/') }
            if (hit != null && st.prefs.viewNodeId == hit.id) c.settings.setViewNodeId("")
            refresh()
        }
    }

    fun addSavedNode(url: String) {
        viewModelScope.launch {
            c.settings.addExtraNode(url.trim().trimEnd('/'))
            refresh()
        }
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

    fun agentForSession(sessionId: String): String? = pointers.agentForSession(sessionId)

    fun adoptChatPointer(agentId: String?, from: String, canonical: String, nodeDenUrl: String) {
        if (!rekeyPinnedDraft(pointers, agentId, from, canonical, nodeDenUrl)) return
        viewModelScope.launch { persistPointers() }
        rebuildItems()
    }

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
        try {
            val identityGen = c.identity.generation()
            _state.update {
                it.copy(
                    loading = true,
                    error = null,
                    errorKind = null,
                    discoveringDone = 0,
                    discoveringTotal = 0,
                )
            }
            val prefs = c.settings.snapshot()
            if (prefs.entryUrl.isBlank()) {
                _state.update { it.copy(nodes = emptyList(), items = emptyList(), agents = emptyList()) }
                return
            }
            c.transport.retarget(prefs.entryUrl, prefs.extraNodes)
            val nodes = c.transport.discover()
            if (c.identity.generation() != identityGen) return
            if (gen != refreshLatch.gen) return
            val live = nodes.map { it.denUrl.trimEnd('/') }.toSet()
            descriptors.keys.filter { it !in live }.forEach { descriptors.remove(it) }
            plane.keys.filter { it !in live }.forEach { plane.remove(it) }
            legacy.keys.filter { it !in live }.forEach { legacy.remove(it) }
            _state.update {
                it.copy(
                    nodes = nodes,
                    discoveringDone = 0,
                    discoveringTotal = nodes.size,
                    nodeErrors = emptyMap(),
                    identityGen = identityGen,
                )
            }
            rebuildItems()
            val presetsAcc = LinkedHashMap<String, Result<List<AgentPreset>>>()
            var catalog: List<CatalogAgent> = emptyList()
            fun publishAgents() {
                val current = _state.value.nodes
                val agents = buildAgents(
                    current.map { AgentNodeHint(it.id, it.name.ifBlank { it.id }, it.denUrl, it.online) },
                    presetsAcc.toList(),
                    catalog,
                    pointers,
                )
                _state.update { it.copy(agents = agents) }
            }
            coroutineScope {
                launch {
                    catalog = runCatching { c.transport.entry().catalogAgents().agents }.getOrDefault(emptyList())
                    if (gen != refreshLatch.gen) return@launch
                    publishAgents()
                }
                fetchBundlesProgressively(
                    nodes = nodes,
                    timeoutMs = NODE_BUNDLE_TIMEOUT_MS,
                    fetch = { fetchNodeBundle(it) },
                    onEach = { node, result ->
                        if (gen == refreshLatch.gen) {
                            applyNodeBundle(node, result, presetsAcc)
                            publishAgents()
                            rebuildItems()
                        }
                    },
                )
            }
            if (gen != refreshLatch.gen) return
            if (c.identity.generation() != identityGen) return
            publishAgents()
            rebuildItems()
            startWatches(_state.value.nodes, identityGen)
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
            _state.update { it.copy(loading = end.latch.loading, discoveringDone = 0, discoveringTotal = 0) }
            if (end.rerun) refresh()
        }
    }

    private suspend fun fetchNodeBundle(node: NodeRef): NodeBundle {
        val hg = c.harness(node.denUrl)
        val gw = c.transport.gateway(node)
        return fetchAfterHealthz(
            healthz = { gw.healthz().ok },
            rest = {
                val desc = runCatching { hg.listHarnesses() }
                val planeRows = HashMap<String, Result<List<HarnessSessionSummary>>>()
                for (hid in listableHarnesses(desc.getOrDefault(emptyList()))) {
                    planeRows[hid] = runCatching { hg.listSessions(hid) }
                }
                val legacyRows = runCatching { hg.legacySessions() }
                val presets = runCatching { gw.agents() }
                val errors = buildList {
                    add(desc.exceptionOrNull())
                    planeRows.values.forEach { add(it.exceptionOrNull()) }
                    add(legacyRows.exceptionOrNull())
                }
                NodeBundle(
                    node = node.copy(online = true),
                    desc = desc.getOrDefault(emptyList()),
                    planeRows = planeRows,
                    legacyRows = legacyRows,
                    ok = true,
                    error = nodeErrorBadge(errors),
                    presets = presets,
                )
            },
            skipped = { _, _ ->
                NodeBundle(
                    node = node.copy(online = false),
                    desc = emptyList(),
                    planeRows = emptyMap(),
                    legacyRows = Result.success(emptyList()),
                    ok = false,
                    error = null,
                    presets = Result.success(emptyList()),
                )
            },
        )
    }

    private fun applyNodeBundle(
        node: NodeRef,
        result: Result<NodeBundle>,
        presetsAcc: MutableMap<String, Result<List<AgentPreset>>>,
    ) {
        val url = node.denUrl.trimEnd('/')
        val bundle = result.getOrNull()
        if (bundle == null) {
            val badge = nodeErrorBadge(listOf(result.exceptionOrNull())) ?: "timed out"
            _state.update { st ->
                st.copy(
                    nodes = st.nodes.map { if (it.id == node.id) it.copy(online = false) else it },
                    nodeErrors = st.nodeErrors + (node.id to badge),
                    discoveringDone = st.discoveringDone + 1,
                )
            }
            return
        }
        if (bundle.ok) {
            descriptors[url] = bundle.desc
            plane[url] = HashMap(bundle.planeRows)
            legacy[url] = bundle.legacyRows
        }
        presetsAcc[url] = bundle.presets
        _state.update { st ->
            val nextErrors = st.nodeErrors.toMutableMap()
            if (bundle.error != null) nextErrors[node.id] = bundle.error else nextErrors.remove(node.id)
            st.copy(
                nodes = st.nodes.map { n ->
                    if (n.id == node.id) n.copy(online = bundle.ok) else n
                },
                nodeErrors = nextErrors,
                discoveringDone = st.discoveringDone + 1,
            )
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
        _state.update { it.copy(registryOpen = watches.isNotEmpty()) }
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
        _state.update { it.copy(registryOpen = false) }
    }

    private data class NodeBundle(
        val node: NodeRef,
        val desc: List<HarnessDescriptor>,
        val planeRows: Map<String, Result<List<HarnessSessionSummary>>>,
        val legacyRows: Result<List<LegacyHarnessSession>>,
        val ok: Boolean,
        val error: String?,
        val presets: Result<List<AgentPreset>>,
    )

}
