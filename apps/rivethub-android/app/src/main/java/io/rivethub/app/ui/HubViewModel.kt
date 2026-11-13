package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.data.AndroidLogger
import io.rivethub.app.data.Prefs
import io.rivethub.app.gateway.HarnessDescriptor
import io.rivethub.app.gateway.HarnessEvent
import io.rivethub.app.gateway.HarnessSessionSummary
import io.rivethub.app.gateway.LegacyHarnessSession
import io.rivethub.app.gateway.AgentPreset
import io.rivethub.app.gateway.CatalogAgent
import io.rivethub.app.gateway.WsStatus
import io.rivethub.app.gateway.NotificationFrame
import io.rivethub.app.plane.AgentAction
import io.rivethub.app.plane.AgentEditFields
import io.rivethub.app.plane.AgentNodeHint
import io.rivethub.app.plane.AgentOpen
import io.rivethub.app.plane.AgentPointers
import io.rivethub.app.plane.AgentRow
import io.rivethub.app.gateway.GatewayException
import io.rivethub.app.gateway.HarnessGateway
import io.rivethub.app.gateway.HubProject
import io.rivethub.app.gateway.TopicSummary
import io.rivethub.app.gateway.TopicsUnsupported
import io.rivethub.app.gateway.nativeIdOf
import io.rivethub.app.gateway.historyMarksOf
import io.rivethub.app.plane.HistoryMark
import io.rivethub.app.plane.archivesToMove
import io.rivethub.app.plane.drawerTopics
import io.rivethub.app.plane.historyArchivedKeys
import io.rivethub.app.plane.titlesToMove
import io.rivethub.app.plane.migratedPlacements
import io.rivethub.app.plane.planPlacements
import io.rivethub.app.plane.planProjectMigration
import io.rivethub.app.plane.topicMembership
import io.rivethub.app.plane.addProject as addProjectTo
import io.rivethub.app.plane.deleteProject as deleteProjectFrom
import io.rivethub.app.plane.openInProject
import io.rivethub.app.plane.placeInProject as placeIn
import io.rivethub.app.plane.projectAgent
import io.rivethub.app.plane.renameProject as renameProjectIn
import io.rivethub.app.plane.ConversationFilter
import io.rivethub.app.plane.EnrollErrorKind
import io.rivethub.app.plane.EntryAnswer
import io.rivethub.app.plane.EntryAnswerState
import io.rivethub.app.plane.entryAnswerStateAtRefreshStart
import io.rivethub.app.plane.publishEntryAnswer
import io.rivethub.app.plane.HarnessSheet
import io.rivethub.app.plane.LocatedChatItem
import io.rivethub.app.plane.agentGoToNodeId
import io.rivethub.app.plane.agentPatchRequest
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
import io.rivethub.app.plane.migrateLocalPrefs
import io.rivethub.app.plane.moveSessionToAgent
import io.rivethub.app.plane.openAgent
import io.rivethub.app.plane.openAgentRow
import io.rivethub.app.plane.pinChatItems
import io.rivethub.app.plane.rekeyPinnedDraft
import io.rivethub.app.plane.requestRefresh
import io.rivethub.app.plane.sortLocatedByRecency
import io.rivethub.app.plane.supersedeRefresh
import io.rivethub.app.plane.toSheet
import io.rivethub.app.plane.RefreshLatch
import io.rivethub.app.transport.NodeRef
import io.rivethub.app.plane.NODE_BUNDLE_TIMEOUT_MS
import io.rivethub.app.plane.fetchAfterHealthz
import io.rivethub.app.plane.fetchBundlesProgressively
import io.rivethub.app.plane.nodeErrorBadge
import io.rivethub.app.plane.InboxEntry
import io.rivethub.app.plane.InboxLabels
import io.rivethub.app.plane.SystemNotifier
import io.rivethub.app.plane.FinishedTurnTracker
import io.rivethub.app.plane.INBOX_KIND_NEEDS_YOU
import io.rivethub.app.plane.NeedsEpisodes
import io.rivethub.app.plane.RECONNECT_BLOCK_GRACE_MS
import io.rivethub.app.plane.StatusBlocks
import io.rivethub.app.plane.withStatusBlocks
import io.rivethub.app.plane.WaitingRow
import io.rivethub.app.plane.shouldNotifySession
import io.rivethub.app.plane.waitingRows
import io.rivethub.app.plane.INBOX_KIND_AGENT_FINISHED
import io.rivethub.app.plane.agentFinishedBody
import io.rivethub.app.plane.shouldNotifyAgentFinished
import io.rivethub.app.plane.inboxEntryFor
import io.rivethub.app.plane.markRead
import io.rivethub.app.plane.NotificationsWatch
import io.rivethub.app.plane.acceptNotificationFrame
import io.rivethub.app.plane.closeNotificationsWatch
import io.rivethub.app.plane.notificationsWatchKey
import io.rivethub.app.plane.notificationsWatchOpened
import io.rivethub.app.plane.reconcileNotificationsWatch
import io.rivethub.app.plane.pushInbox
import io.rivethub.app.plane.runNotificationHook
import io.rivethub.app.plane.shouldPostSystemNotification
import io.rivethub.app.plane.unreadCount
import io.rivethub.app.gateway.SESSION_DELETE_BATCH_MAX
import io.rivethub.app.gateway.SessionDeleteUnsupported
import io.rivethub.app.gateway.SessionTrashCandidate
import io.rivethub.app.plane.DeleteFailure
import io.rivethub.app.plane.DeleteOutcome
import io.rivethub.app.plane.deleteTargetFor
import io.rivethub.app.plane.failAll
import io.rivethub.app.plane.foldDeleteResults
import io.rivethub.app.plane.localKeysFor
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.io.Closeable

/**
 * [inboxLabels] — the inbox titles, built by MainActivity from strings.xml
 * (plane/InboxLabels has no English defaults; resources are the one source).
 */
class HubViewModel(private val c: AppContainer, inboxLabels: InboxLabels) : ViewModel() {
    enum class Tab { Conversations, Settings }

    data class DraftRow(
        val id: String,
        val nodeDenUrl: String,
        val nodeId: String,
        val nodeName: String,
        val harnessId: String?,
        val createdAt: Long,
    )

    data class UiState(
        val tab: Tab = Tab.Conversations,
        val nodes: List<NodeRef> = emptyList(),
        val items: List<LocatedChatItem> = emptyList(),
        val agents: List<AgentRow> = emptyList(),
        val filter: ConversationFilter = ConversationFilter.All,
        val query: String = "",
        val archived: Set<String> = emptySet(),
        val titleOverrides: Map<String, String> = emptyMap(),
        /** Local-only pin / hide sets (prefs `pinned` / `hidden`). */
        val pinned: Set<String> = emptySet(),
        val hidden: Set<String> = emptySet(),
        val loading: Boolean = false,
        val error: String? = null,
        val errorKind: EnrollErrorKind? = null,
        val nodeErrors: Map<String, String> = emptyMap(),
        val discoveringDone: Int = 0,
        val discoveringTotal: Int = 0,
        /** In-memory notifications inbox (newest first, capped — plane/Inbox.kt). */
        val inbox: List<InboxEntry> = emptyList(),
        val unread: Int = 0,
        /** The inbox sheet is showing (lifted here so a tapped OS notification can open it). */
        val inboxOpen: Boolean = false,
        val prefs: Prefs = Prefs(),
        val identityGen: Int = 0,
        val registryOpen: Boolean = false,
        /** `GET /api/agents` directoryRoot, when any node reported one. */
        val directoryRoot: String? = null,
        /**
         * Last outcome of the entry's own `discover()` call (hub dot, fix2). Read it
         * through `entryAnsweredFor(entryAnswer, prefs.entryUrl, identityGen)`,
         * which yields null for another entry URL / identity generation.
         */
        val entryAnswer: EntryAnswer? = null,
        /** Conversations waiting on you, oldest first (plane/NeedsYou.kt). */
        val needsYou: List<WaitingRow> = emptyList(),
        /**
         * The entry node answers rh topics (plane/Topics.kt): the drawer's
         * sections are [topics] and [topicMembership], not the hub-state projects.
         */
        val topicsOn: Boolean = false,
        val topics: List<HubProject> = emptyList(),
        val topicMembership: Map<String, String> = emptyMap(),
    ) {
        /** What the drawer's project sections show: topics when the node has them. */
        val drawerProjects: List<HubProject> get() = if (topicsOn) topics else prefs.projects
        val drawerMembership: Map<String, String> get() = if (topicsOn) topicMembership else prefs.projectMembership
    }

    /** A topic change rh refused, for the drawer's snackbar. */
    sealed interface TopicNotice {
        data object HasSubtopics : TopicNotice
        data class Failed(val detail: String) : TopicNotice
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val pointers = AgentPointers()
    private var pointersLoaded = false
    private val drafts = ArrayList<DraftRow>()
    private val plane = HashMap<String, HashMap<String, Result<List<HarnessSessionSummary>>>>()
    private val legacy = HashMap<String, Result<List<LegacyHarnessSession>>>()
    private val descriptors = HashMap<String, List<HarnessDescriptor>>()
    private val watches = HashMap<String, Closeable>()
    private val watchStatus = java.util.concurrent.ConcurrentHashMap<String, WsStatus>()
    private var refreshLatch = RefreshLatch()
    private var refreshJob: Job? = null
    private val registryFrames = Channel<RegistryMail>(Channel.UNLIMITED)

    /** A registry frame, or (event == null) the node's registry socket (re)opening. */
    private data class RegistryMail(val nodeUrl: String, val event: HarnessEvent?, val identityGen: Int)

    /**
     * The ONE notifications socket (entry node) and its ownership state —
     * key + subscription generation (plane/NotificationsWatch.kt).
     */
    private var notifSocket: Closeable? = null
    private var notifWatch = NotificationsWatch()
    private val notifFrames = Channel<NotifMail>(Channel.UNLIMITED)

    /** [gen] is the subscription generation captured when the socket was opened. */
    private data class NotifMail(val gen: Int, val frame: NotificationFrame)

    /**
     * Titles for inbox entries, from strings.xml: set at construction and
     * refreshed by MainActivity on recomposition (a locale change outlives
     * the VM).
     */
    @Volatile var inboxLabels: InboxLabels = inboxLabels

    /**
     * Called on every `task.done` frame with its task id. The Tasks screen
     * (slice D2) wires this to `TasksViewModel.refresh()`; null until then.
     */
    @Volatile var onTaskDone: ((taskId: String) -> Unit)? = null

    /** Posts the OS notification for a backgrounded completion (notify/TaskNotifier). */
    @Volatile var systemNotifier: SystemNotifier? = null

    /** True while the app is on screen; read per frame (see notify/AppVisibility). */
    @Volatile var appResumed: () -> Boolean = { true }

    /** The session key of the chat on screen, if any — its own finished reply is not notified. */
    @Volatile var openSessionKey: () -> String? = { null }

    /** "Agent finished replying" notice title (strings.xml; MainActivity hands it over). */
    @Volatile var agentFinishedTitle: String = ""

    /** active → idle edges from every node's registry stream (plane/FinishedTurns.kt). */
    private val finishedTurns = FinishedTurnTracker()

    /** "Needs you" notice title (strings.xml; MainActivity hands it over). */
    @Volatile var needsYouTitle: String = ""

    /** Waiting episodes (plane/NeedsYou.kt); primed until the first full refresh lands. */
    private val needsEpisodes = NeedsEpisodes()
    private var rosterSettled = false

    /** Nodes whose roster has been reconciled once (a late node primes, never announces). */
    private val settledNodes = HashSet<String>()

    /** Nodes whose bundle has landed a roster (a registry frame alone does not count). */
    private val landedNodes = HashSet<String>()

    /** Registry `status: 'blocked'` frames per node URL (ACP drivers; plane/NeedsYou.kt). */
    private val statusBlocks = HashMap<String, StatusBlocks>()

    /** Identity generation the episode/turn trackers belong to; a switch resets them. */
    private var trackersIdentityGen: Int? = null

    init {
        viewModelScope.launch {
            for (mail in registryFrames) {
                val event = mail.event
                if (event == null) onRegistryOpen(mail.nodeUrl, mail.identityGen)
                else onRegistry(mail.nodeUrl, event, mail.identityGen)
            }
        }
        viewModelScope.launch {
            for (mail in notifFrames) onNotification(mail.gen, mail.frame)
        }
        viewModelScope.launch {
            c.settings.prefs.collect { p ->
                c.setStrictHostnames(p.strictHostnames)
                loadPointers(p)
                // The saved entry URL is authoritative for the notifications
                // socket: an entry saved without a refresh (Settings "Test
                // connection", even when its health check then fails) still
                // moves the socket and empties the old node's inbox here.
                reconcileNotificationWatch(p.entryUrl, c.identity.generation())
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
                        pinned = p.pinned,
                        hidden = p.hidden,
                        identityGen = c.identity.generation(),
                        filter = filter,
                    )
                }
                publishArchived() // rh's History marks on top of the phone's archive
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

    /**
     * Archived sessions live in the archive, not in a project (the old
     * desktop's rule). A topic placement stays: rh keeps filing and done
     * marks apart (contract note 36).
     */
    fun archive(key: String) {
        val session = if (_state.value.topicsOn) canonicalForKey(key) else null
        if (session != null) {
            // rh's History mark, what desktop shows; shown archived at once.
            historyMarks = historyMarks.filter { it.sessionId != session } + HistoryMark(session, System.currentTimeMillis())
            publishArchived()
            topicCall { it.markHistory(session) }
            return
        }
        viewModelScope.launch {
            c.settings.archive(key)
            if (!_state.value.topicsOn) c.settings.editProjects { placeIn(it, key, null) }
        }
    }
    fun unarchive(key: String) {
        viewModelScope.launch { c.settings.unarchive(key) }
        val session = if (_state.value.topicsOn) canonicalForKey(key) else null
        if (session != null && historyMarks.any { it.sessionId == session }) {
            historyMarks = historyMarks.filter { it.sessionId != session }
            publishArchived()
            topicCall { it.unmarkHistory(session) }
        }
    }
    /**
     * Rename on rh (the session's own node) so desktop shows it too; the
     * phone keeps the name locally until rh takes it, and for drafts, older
     * nodes and a cleared name.
     */
    fun rename(key: String, title: String) {
        viewModelScope.launch {
            c.settings.setTitleOverride(key, title)
            val clean = title.trim()
            val node = nodeOfKey(key) ?: return@launch
            val session = canonicalForKey(key) ?: return@launch
            if (clean.isNotEmpty() && retitleOnNode(node, session, clean)) c.settings.setTitleOverride(key, "")
        }
    }
    fun pin(key: String) {
        viewModelScope.launch { c.settings.pin(key) }
    }
    fun unpin(key: String) {
        viewModelScope.launch { c.settings.unpin(key) }
    }
    fun hide(key: String) {
        viewModelScope.launch { c.settings.hide(key) }
    }

    // -- Topics (rh, plane/Topics.kt), else projects (hub state, plane/Projects.kt) --

    private val _topicNotices = MutableSharedFlow<TopicNotice>(extraBufferCapacity = 4)
    val topicNotices: SharedFlow<TopicNotice> = _topicNotices

    /** Every work topic the entry answered, closed ones included (ids for placement checks). */
    private var rawTopics: List<TopicSummary> = emptyList()
    /** Canonical session id → topic id, as rh last answered. */
    private var placedNow: Map<String, String> = emptyMap()
    private var topicsJob: Job? = null
    @Volatile private var topicsAgain = false

    private fun entryHarness(): HarnessGateway? =
        _state.value.prefs.entryUrl.trim().trimEnd('/').takeIf { it.isNotEmpty() }?.let { c.harness(it) }

    /** Re-read topics and filings from the entry node. Coalesces: a call during a load runs once more after it. */
    fun loadTopics() {
        val hg = entryHarness() ?: return
        if (topicsJob?.isActive == true) {
            topicsAgain = true
            return
        }
        topicsJob = viewModelScope.launch {
            do {
                topicsAgain = false
                loadTopicsOnce(hg)
            } while (topicsAgain)
        }
    }

    private suspend fun loadTopicsOnce(hg: HarnessGateway) {
        val topics = try {
            hg.listTopics()
        } catch (e: TopicsUnsupported) {
            _state.update { it.copy(topicsOn = false, topics = emptyList(), topicMembership = emptyMap()) }
            return
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            AndroidLogger.warn("RivetHub", "topics read failed: ${e.message}", e)
            return
        }
        val whole = try {
            hg.filing()
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            AndroidLogger.warn("RivetHub", "topic filing read failed: ${e.message}", e)
            return // keep the last membership rather than show everything unfiled
        }
        val filing = whole.sessions
        historyMarks = historyMarksOf(whole.history)
        rawTopics = topics
        val ids = topics.map { it.id }.toSet()
        placedNow = filing.filter { it.topicId in ids }.associate { it.sessionId to it.topicId }
        _state.update { it.copy(topicsOn = true, topics = drawerTopics(topics), topicMembership = topicMembership(filing, ids)) }
        publishArchived()
        if (migrateProjects(hg, topics)) topicsAgain = true
        if (sendPendingPlacements(hg)) topicsAgain = true
        if (moveArchives(hg)) topicsAgain = true
        moveTitles()
    }

    /** rh history marks, from the last filing read. */
    private var historyMarks: List<HistoryMark> = emptyList()

    /**
     * The drawer's archive: the phone's own (drafts, older nodes) plus rh's
     * history marks that no activity has cleared (plane/Topics.kt).
     */
    private fun publishArchived() {
        _state.update { st ->
            val marked = if (st.topicsOn) {
                val byId = st.items.associateBy({ it.item.sessionId ?: it.item.key }, { it.item.updatedAt.takeIf { t -> t > 0 } })
                historyArchivedKeys(historyMarks) { byId[it] }
            } else {
                emptySet()
            }
            st.copy(archived = st.prefs.archived + marked)
        }
    }

    /** Move phone-only archive marks to rh once (desktop's History). True when any moved. */
    private suspend fun moveArchives(hg: HarnessGateway): Boolean {
        val marked = historyMarks.map { it.sessionId }.toSet()
        val moves = archivesToMove(c.settings.snapshot().archived, ::canonicalForKey, marked)
        if (moves.isEmpty()) return false
        var moved = false
        for ((key, session) in moves) {
            try {
                hg.markHistory(session)
                c.settings.unarchive(key)
                moved = true
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                AndroidLogger.warn("RivetHub", "moving archive of $session to History failed: ${e.message}", e)
            }
        }
        return moved
    }

    /** The node a drawer key's row lives on, if listed. */
    private fun nodeOfKey(key: String): String? =
        _state.value.items.firstOrNull { it.item.key == key || it.item.sessionId == key }?.nodeDenUrl

    /**
     * Move phone-only names to rh once, each on its session's node, so desktop
     * shows them. A node without the title route keeps the name local.
     */
    private suspend fun moveTitles() {
        val moves = titlesToMove(c.settings.snapshot().titleOverrides) { key ->
            if (nodeOfKey(key) == null) null else canonicalForKey(key)
        }
        for (m in moves) {
            val node = nodeOfKey(m.key) ?: continue
            if (retitleOnNode(node, m.session, m.title)) c.settings.setTitleOverride(m.key, "")
        }
    }

    /** PUT the title on [node]; true when rh took it. The cached row takes the new title at once. */
    private suspend fun retitleOnNode(node: String, session: String, title: String): Boolean = try {
        val renamed = c.harness(node).retitle(session, title)
        replaceCachedSummary(node.trimEnd('/'), renamed)
        true
    } catch (e: TopicsUnsupported) {
        false
    } catch (e: Exception) {
        if (e is kotlinx.coroutines.CancellationException) throw e
        AndroidLogger.warn("RivetHub", "renaming $session failed: ${e.message}", e)
        false
    }

    private fun replaceCachedSummary(node: String, summary: io.rivethub.app.gateway.HarnessSessionSummary) {
        val rows = plane[node] ?: return
        for (entry in rows.entries) {
            val list = entry.value.getOrNull() ?: continue
            if (list.none { it.sessionId == summary.sessionId }) continue
            entry.setValue(Result.success(list.map { if (it.sessionId == summary.sessionId) summary else it }))
        }
        rebuildItems()
    }

    /**
     * Move the hub-state projects to topics once: a project joins the topic of
     * the same name, or becomes a new one, and its sessions are queued for
     * placement. Then the projects leave hub state. True when anything moved.
     * A failed create stops here; the next load retries and matches by name.
     */
    private suspend fun migrateProjects(hg: HarnessGateway, topics: List<TopicSummary>): Boolean {
        val prefs = c.settings.snapshot()
        if (prefs.projects.isEmpty()) return false
        val plan = planProjectMigration(prefs.projects, topics)
        val topicOf = HashMap(plan.reuse)
        for (p in plan.create) {
            topicOf[p.id] = try {
                hg.createTopic(p.name).id
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                AndroidLogger.warn("RivetHub", "moving project \"${p.name}\" to a topic failed: ${e.message}", e)
                return plan.create.first() != p
            }
        }
        c.settings.finishProjectMigration(migratedPlacements(prefs.projectMembership, topicOf))
        return true
    }

    /** The canonical session id a drawer key names, or null while it is a draft or unknown. */
    private fun canonicalForKey(key: String): String? {
        val row = _state.value.items.firstOrNull { it.item.key == key || it.item.sessionId == key }
        if (row != null) return deleteTargetOf(row)?.session
        // Not listed (archived away, another node offline): a canonical key can still be filed.
        return key.takeIf { nativeIdOf(it) != null }
    }

    /** File what is waiting (plane/Topics.kt planPlacements). True when rh took any. */
    private suspend fun sendPendingPlacements(hg: HarnessGateway): Boolean {
        val pending = c.settings.snapshot().pendingPlacements
        if (pending.isEmpty()) return false
        val plan = planPlacements(pending, ::canonicalForKey, rawTopics.map { it.id }.toSet(), placedNow)
        val done = HashSet(plan.drop)
        var placed = false
        for (w in plan.send) {
            try {
                hg.placeSession(w.session, w.topicId)
                done += w.key
                placed = true
            } catch (e: GatewayException) {
                // Refused for good (unknown session, a non-work topic): drop it. Anything else retries next load.
                if (e.status in 400..499) done += w.key
                AndroidLogger.warn("RivetHub", "filing ${w.session} failed: ${e.message}", e)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                AndroidLogger.warn("RivetHub", "filing ${w.session} failed: ${e.message}", e)
            }
        }
        if (done.isNotEmpty()) c.settings.dropPendingPlacements(done)
        return placed
    }

    /** One topic call; failures go to the drawer's snackbar. Reloads after. */
    private fun topicCall(block: suspend (HarnessGateway) -> Unit) {
        val hg = entryHarness() ?: return
        viewModelScope.launch {
            try {
                block(hg)
            } catch (e: GatewayException) {
                _topicNotices.tryEmit(if (e.status == 409) TopicNotice.HasSubtopics else TopicNotice.Failed(e.message.orEmpty()))
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                _topicNotices.tryEmit(TopicNotice.Failed(e.message ?: e.javaClass.simpleName))
            }
            loadTopics()
        }
    }

    fun addProject(name: String) {
        val clean = name.trim().take(io.rivethub.app.plane.PROJECT_NAME_MAX).trim()
        if (_state.value.topicsOn) {
            if (clean.isNotEmpty()) topicCall { it.createTopic(clean) }
            return
        }
        val id = java.util.UUID.randomUUID().toString()
        viewModelScope.launch { c.settings.editProjects { addProjectTo(it, name, id, System.currentTimeMillis()) } }
    }
    fun renameProject(id: String, name: String) {
        val clean = name.trim().take(io.rivethub.app.plane.PROJECT_NAME_MAX).trim()
        if (_state.value.topicsOn) {
            if (clean.isNotEmpty()) topicCall { it.renameTopic(id, clean) }
            return
        }
        viewModelScope.launch { c.settings.editProjects { renameProjectIn(it, id, name) } }
    }
    fun deleteProject(id: String) {
        if (_state.value.topicsOn) {
            topicCall { it.deleteTopic(id) }
            return
        }
        viewModelScope.launch { c.settings.editProjects { deleteProjectFrom(it, id) } }
    }
    /** Move a session into [projectId], or out of every project when null. Filing unarchives it. */
    fun placeInProject(key: String, projectId: String?) {
        if (_state.value.topicsOn) {
            viewModelScope.launch { if (projectId != null) c.settings.unarchive(key) }
            val session = canonicalForKey(key)
            if (session == null) {
                // Still a draft: filed once the node adopts it.
                viewModelScope.launch { c.settings.setPendingPlacement(key, projectId) }
                return
            }
            topicCall { hg -> if (projectId == null) hg.unplaceSession(session) else hg.placeSession(session, projectId) }
            return
        }
        viewModelScope.launch {
            if (projectId != null) c.settings.unarchive(key)
            c.settings.editProjects { placeIn(it, key, projectId) }
        }
    }

    /**
     * "+" inside a project: a new draft for [agent] (or the project's default
     * agent), started in the project's directory and filed under the
     * project. Null when the project names no usable agent and none was
     * given: the caller asks which agent. A topic names no agent, so it always
     * asks; the draft is filed under the topic once the node adopts it.
     */
    fun startInProject(project: HubProject, agent: AgentRow? = null): AgentOpen? {
        val row = agent ?: projectAgent(project, _state.value.agents) ?: return null
        val open = openAgentAction(row, AgentAction.Plus) ?: return null
        viewModelScope.launch {
            if (_state.value.topicsOn) {
                c.settings.setPendingPlacement(open.sessionId, project.id)
            } else {
                c.settings.editProjects { placeIn(it, open.sessionId, project.id) }
            }
        }
        return openInProject(open, project)
    }

    /**
     * Long-press → Move to agent: [agentId]'s pointer now names [sessionKey]
     * (on the node the row lives on) and any other agent pointing at it lets
     * go (plane/ConversationMenu.kt moveSessionToAgent). Local pointer state
     * only — no den call; the agent's previous session stays on the node.
     * When the moved row is the open conversation ([isOpen]), the current
     * agent follows it, so `+ new` mints for the agent that now owns it.
     */
    fun moveToAgent(sessionKey: String, agentId: String, isOpen: Boolean = false) {
        val row = _state.value.items.find { it.item.key == sessionKey } ?: return
        val before = pointers.all()
        val after = moveSessionToAgent(before, sessionKey, agentId, row.nodeDenUrl, System.currentTimeMillis())
        for (id in before.keys) if (id !in after) pointers.clear(id)
        for ((id, ptr) in after) {
            val prev = before[id]
            if (prev == null || prev.sessionId != ptr.sessionId || prev.nodeBaseUrl != ptr.nodeBaseUrl) {
                pointers.set(id, ptr.sessionId, ptr.nodeBaseUrl, replace = true)
            }
        }
        _state.update { st ->
            st.copy(agents = st.agents.map { a -> a.copy(pointerSessionId = pointers.get(a.agentId)?.sessionId) })
        }
        viewModelScope.launch {
            persistPointers()
            if (isOpen) c.settings.setCurrentAgentId(agentId)
        }
        rebuildItems()
    }

    fun discardDraft(id: String) {
        drafts.removeAll { it.id == id }
        val pinned = pointers.all().entries.find { it.value.sessionId == id }?.key
        if (pinned != null) pointers.clear(pinned)
        viewModelScope.launch { persistPointers() }
        rebuildItems()
    }

    // -- Delete + clean up (plane/SessionDelete.kt) --

    /** A session to delete and the node that owns it. */
    data class DeleteTarget(val session: String, val nodeDenUrl: String)

    /** One clean-up candidate and the node that offered it. */
    data class TrashRow(val candidate: SessionTrashCandidate, val nodeDenUrl: String, val nodeName: String)

    /** A clean-up review read: [unsupported] when no node answered with the route. */
    data class TrashLoad(val rows: List<TrashRow>, val unsupported: Boolean, val failedNodes: Int)

    /** The delete target for a drawer row, or null when it offers no Delete. */
    fun deleteTargetOf(row: LocatedChatItem): DeleteTarget? =
        deleteTargetFor(row.item, _state.value.agents.mapNotNull { it.pointerSessionId })
            ?.let { DeleteTarget(it, row.nodeDenUrl) }

    /**
     * Delete [targets] on their own nodes, in batches of the bulk cap. Only
     * what a node reports deleted is swept locally; a live, missing or failed
     * session keeps its row and every local trace. [onDone] runs on the main
     * thread with the folded outcome.
     */
    fun deleteSessions(targets: List<DeleteTarget>, onDone: (DeleteOutcome) -> Unit) {
        if (targets.isEmpty()) return
        viewModelScope.launch {
            var outcome = DeleteOutcome()
            for ((url, group) in targets.distinct().groupBy { it.nodeDenUrl.trimEnd('/') }) {
                val hg = c.harness(url)
                for (chunk in group.map { it.session }.chunked(SESSION_DELETE_BATCH_MAX)) {
                    outcome += try {
                        foldDeleteResults(chunk, hg.deleteSessions(chunk).results)
                    } catch (e: SessionDeleteUnsupported) {
                        failAll(chunk, DeleteFailure.Error, e.message.orEmpty())
                    } catch (e: Exception) {
                        if (e is kotlinx.coroutines.CancellationException) throw e
                        failAll(chunk, DeleteFailure.Error, e.message ?: e.javaClass.simpleName)
                    }
                }
            }
            if (outcome.deleted.isNotEmpty()) forgetDeleted(outcome.deleted.toSet())
            onDone(outcome)
        }
    }

    private suspend fun forgetDeleted(deleted: Set<String>) {
        val keys = deleted.flatMap(::localKeysFor).toSet()
        for (rows in plane.values) {
            for (entry in rows.entries) {
                val list = entry.value.getOrNull() ?: continue
                entry.setValue(Result.success(list.filter { it.sessionId !in keys }))
            }
        }
        for (entry in legacy.entries) {
            val list = entry.value.getOrNull() ?: continue
            entry.setValue(Result.success(list.filter { it.id !in keys }))
        }
        var droppedPointer = false
        for ((agentId, ptr) in pointers.all()) {
            if (ptr.sessionId in keys) {
                pointers.clear(agentId)
                droppedPointer = true
            }
        }
        if (droppedPointer) persistPointers()
        c.settings.forgetSessions(keys)
        rebuildItems()
    }

    /** Keep [target] out of the clean-up review (it returns only if used again and still trash). Null error = kept. */
    fun keepSession(target: DeleteTarget, onDone: (error: String?) -> Unit) {
        viewModelScope.launch {
            val error = try {
                c.harness(target.nodeDenUrl).keepSession(target.session)
                null
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                e.message ?: e.javaClass.simpleName
            }
            onDone(error)
        }
    }

    /** Read every online node's clean-up candidates. */
    fun loadTrash(onDone: (TrashLoad) -> Unit) {
        val nodes = _state.value.nodes.filter { it.online }
        viewModelScope.launch {
            val rows = ArrayList<TrashRow>()
            var unsupported = 0
            var failed = 0
            coroutineScope {
                nodes.map { node ->
                    node to async { runCatching { c.harness(node.denUrl).trashSessions() } }
                }.forEach { (node, call) ->
                    call.await().fold(
                        onSuccess = { list ->
                            list.forEach { rows += TrashRow(it, node.denUrl, node.name.ifBlank { node.id }) }
                        },
                        onFailure = { if (it is SessionDeleteUnsupported) unsupported++ else failed++ },
                    )
                }
            }
            onDone(TrashLoad(rows, unsupported = nodes.isNotEmpty() && unsupported == nodes.size, failedNodes = failed))
        }
    }

    fun agentForSession(sessionId: String): String? = pointers.agentForSession(sessionId)

    fun adoptChatPointer(agentId: String?, from: String, canonical: String, nodeDenUrl: String) {
        // Pin / hide follow the session whether or not an agent pointer does.
        migrateLocalKeys(from, canonical)
        if (!rekeyPinnedDraft(pointers, agentId, from, canonical, nodeDenUrl)) return
        viewModelScope.launch { persistPointers() }
        rebuildItems()
    }

    /**
     * A session key moved [from] → [to]: carry the local pin / hide marks
     * along (plane/ConversationIdentity.kt migrateLocalPrefs). State updates
     * now so the adopted row never renders unpinned or un-hidden for a frame;
     * the prefs flow then confirms it from the single DataStore edit. The
     * edit always runs (a pin write may still be in flight); DataStore skips
     * the disk write when nothing changed.
     */
    private fun migrateLocalKeys(from: String, to: String) {
        if (from.isBlank() || to.isBlank() || from == to) return
        _state.update {
            val (pinned, hidden) = migrateLocalPrefs(it.pinned, it.hidden, from, to)
            it.copy(pinned = pinned, hidden = hidden)
        }
        viewModelScope.launch { c.settings.migrateKeys(from, to) }
    }

    fun openAgentAction(row: AgentRow, action: AgentAction): AgentOpen? {
        val open = openAgentRow(row, pointers, action) ?: return null
        if (open.draft) addDraft(open, row.nodeId, row.nodeName)
        viewModelScope.launch {
            c.settings.setCurrentAgentId(row.agentId)
            persistPointers()
        }
        rebuildItems()
        return open
    }

    /**
     * Long-press → Go to node (2026-09-04). `selectViewNode` TOGGLES the
     * filter off when the node is already selected, so the pure guard
     * (`agentGoToNodeId`) vetoes that case — go-to-node never leaves the
     * agent's node.
     */
    fun goToAgentNode(row: AgentRow) {
        val target = agentGoToNodeId(_state.value.prefs.viewNodeId, row.nodeId) ?: return
        selectViewNode(target, row.nodeName)
    }

    /**
     * The target node's capability sheet for [harnessId] (edit-sheet model/
     * effort options), keyed by denUrl the way `descriptors` is populated in
     * `applyNodeBundle`. Null when the node has not reported descriptors.
     */
    fun sheetFor(nodeDenUrl: String, harnessId: String?): HarnessSheet? {
        if (harnessId.isNullOrBlank()) return null
        val desc = descriptors[nodeDenUrl.trim().trimEnd('/')] ?: return null
        return desc.find { it.harnessId == harnessId }?.capabilities?.toSheet()
    }

    /** Per-den harness sheets for NEW-conversation pickers (`launchableAgents`). */
    fun descriptorsByDenUrl(): Map<String, List<HarnessDescriptor>> = HashMap(descriptors)

    /**
     * Long-press → Edit → Save: the SAME den PATCH the web editor sends
     * (`PATCH /api/agents/{id}`), issued against the node the agent LIVES on
     * (`row.nodeDenUrl`). The node itself is immutable. Refreshes on success;
     * [onDone] reports the outcome on the VM scope.
     */
    fun saveAgent(row: AgentRow, fields: AgentEditFields, onDone: (ok: Boolean) -> Unit) {
        viewModelScope.launch {
            val ok = try {
                val home = row.nodeDenUrl.trim().trimEnd('/')
                val node = _state.value.nodes.find { it.denUrl.trimEnd('/') == home }
                    ?: NodeRef(id = row.nodeId, name = row.nodeName, denUrl = home, online = true, fromMesh = false)
                c.transport.gateway(node).agentUpdate(row.agentId, agentPatchRequest(fields, row))
                refresh()
                true
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                false
            }
            onDone(ok)
        }
    }

    fun markInboxRead(id: String) {
        _state.update {
            val next = markRead(it.inbox, id)
            it.copy(inbox = next, unread = unreadCount(next))
        }
    }

    fun setInboxOpen(open: Boolean) {
        _state.update { it.copy(inboxOpen = open) }
    }

    fun clearInbox() {
        _state.update { it.copy(inbox = emptyList(), unread = 0) }
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
        closeNotificationWatch()
        c.dropClients()
        pointersLoaded = false
        drafts.clear()
        plane.clear()
        legacy.clear()
        descriptors.clear()
        resetSessionTrackers(null)
        _state.value = UiState()
    }

    override fun onCleared() {
        closeWatches()
        closeNotificationWatch()
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

    /** Forget needs-you episodes, finished-turn edges and status blocks (new identity / forget). */
    private fun resetSessionTrackers(identityGen: Int?) {
        trackersIdentityGen = identityGen
        rosterSettled = false
        settledNodes.clear()
        landedNodes.clear()
        statusBlocks.clear()
        needsEpisodes.clear()
        finishedTurns.clear()
    }

    private suspend fun refreshOnce(gen: Int) {
        try {
            val identityGen = c.identity.generation()
            if (trackersIdentityGen != identityGen) resetSessionTrackers(identityGen)
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
            // Sticky across a refresh of the same entry; dropped for a new entry URL / identity.
            // The read clock (UiState.identityGen) moves with it: the identity can change
            // without a prefs tick (Settings cert install → refresh), fix3.
            _state.update {
                val start = entryAnswerStateAtRefreshStart(it.entryAnswer, prefs.entryUrl, identityGen)
                it.copy(entryAnswer = start.answer, identityGen = start.identityGen)
            }
            if (prefs.entryUrl.isBlank()) {
                reconcileNotificationWatch("", identityGen)
                _state.update { it.copy(nodes = emptyList(), items = emptyList(), agents = emptyList()) }
                return
            }
            c.transport.retarget(prefs.entryUrl, prefs.extraNodes)
            // The notifications socket needs only the entry URL; it reconnects on
            // its own, so it opens even when discovery below fails. Also run
            // here (not only from the prefs collector) for an identity bump
            // that does not touch prefs.
            reconcileNotificationWatch(prefs.entryUrl, identityGen)
            // The discovery boundary: the only place the hub dot's entry outcome is recorded.
            // The refresh-wide catch below is too broad for this (it also sees per-node and
            // catalog failures), so classify here and let the exception continue as before.
            val nodes = try {
                c.transport.discover()
            } catch (e: Exception) {
                if (e !is kotlinx.coroutines.CancellationException) {
                    noteEntryAnswer(prefs.entryUrl, identityGen, gen, answered = false)
                }
                throw e
            }
            if (c.identity.generation() != identityGen) return
            if (gen != refreshLatch.gen) return
            noteEntryAnswer(prefs.entryUrl, identityGen, gen, answered = true)
            val live = nodes.map { it.denUrl.trimEnd('/') }.toSet()
            descriptors.keys.filter { it !in live }.forEach { descriptors.remove(it) }
            plane.keys.filter { it !in live }.forEach { plane.remove(it) }
            statusBlocks.keys.retainAll(live)
            settledNodes.retainAll(live)
            landedNodes.retainAll(live)
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
            val meta = RosterMeta()
            var catalog: List<CatalogAgent> = emptyList()
            fun publishAgents() {
                val current = _state.value.nodes
                val agents = buildAgents(
                    current.map { hintFor(it, meta) },
                    presetsAcc.toList(),
                    catalog,
                    pointers,
                )
                _state.update { it.copy(agents = agents, directoryRoot = meta.directoryRoot) }
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
                            applyNodeBundle(node, result, presetsAcc, meta)
                            publishAgents()
                            rebuildItems()
                        }
                    },
                )
            }
            if (gen != refreshLatch.gen) return
            if (c.identity.generation() != identityGen) return
            rosterSettled = true
            publishAgents()
            rebuildItems()
            startWatches(_state.value.nodes, identityGen)
            loadTopics()
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

    /**
     * Stale generations (refresh or identity) are rejected inside [publishEntryAnswer]. An
     * accepted write publishes the answer AND the identity generation it was keyed to, so the
     * hub dot's read clock agrees with it on the failure path too (fix3).
     */
    private fun noteEntryAnswer(entryUrl: String, identityGen: Int, gen: Int, answered: Boolean) {
        val liveRefreshGen = refreshLatch.gen
        val liveIdentityGen = c.identity.generation()
        _state.update {
            val next = publishEntryAnswer(
                EntryAnswerState(it.entryAnswer, it.identityGen),
                entryUrl, identityGen, answered, gen, liveRefreshGen, liveIdentityGen,
            )
            it.copy(entryAnswer = next.answer, identityGen = next.identityGen)
        }
    }

    private suspend fun fetchNodeBundle(node: NodeRef): NodeBundle {
        val hg = c.harness(node.denUrl)
        val gw = c.transport.gateway(node)
        var healthNode = ""
        return fetchAfterHealthz(
            healthz = {
                val hz = gw.healthz()
                healthNode = hz.node
                hz.ok
            },
            rest = {
                val desc = runCatching { hg.listHarnesses() }
                val planeRows = HashMap<String, Result<List<HarnessSessionSummary>>>()
                for (hid in listableHarnesses(desc.getOrDefault(emptyList()))) {
                    planeRows[hid] = runCatching { hg.listSessions(hid) }
                }
                val legacyRows = runCatching { hg.legacySessions() }
                val listed = runCatching { gw.agents() }
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
                    presets = listed.map { it.agents },
                    meshNode = healthNode,
                    directoryRoot = listed.getOrNull()?.directoryRoot,
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
                    meshNode = healthNode,
                )
            },
        )
    }

    private fun applyNodeBundle(
        node: NodeRef,
        result: Result<NodeBundle>,
        presetsAcc: MutableMap<String, Result<List<AgentPreset>>>,
        meta: RosterMeta,
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
            landedNodes += url
            descriptors[url] = bundle.desc
            plane[url] = HashMap(bundle.planeRows)
            legacy[url] = bundle.legacyRows
        }
        presetsAcc[url] = bundle.presets
        if (bundle.meshNode.isNotBlank()) {
            meta.meshNodes[url] = bundle.meshNode
            nodeIds[url] = bundle.meshNode
            if (bundle.ok) c.hubState.noteSessionNodes(sessionNodesOf(bundle))
        }
        val root = bundle.directoryRoot?.trim()?.trimEnd('/').orEmpty()
        if (root.isNotEmpty() && meta.directoryRoot.isNullOrBlank()) meta.directoryRoot = root
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
        (watches.keys - live).forEach { url ->
            watches.remove(url)?.close()
            watchStatus.remove(url)
        }
        for (node in nodes) {
            val url = node.denUrl.trimEnd('/')
            if (watches.containsKey(url)) continue
            val hg = c.harness(url)
            watches[url] = hg.watchRegistry(
                onEvent = { event -> registryFrames.trySend(RegistryMail(url, event, identityGen)) },
                onStatus = { status ->
                    watchStatus[url] = status
                    // Through the frame channel so the drop is ordered before the new socket's frames.
                    if (status == WsStatus.OPEN) registryFrames.trySend(RegistryMail(url, null, identityGen))
                    _state.update { it.copy(registryOpen = watchStatus.values.any { s -> s == WsStatus.OPEN }) }
                },
            )
        }
        _state.update { it.copy(registryOpen = watchStatus.values.any { it == WsStatus.OPEN }) }
    }

    /**
     * A node's registry socket (re)opened. Status frames missed while it was
     * down are never replayed, so its status-derived blocks are dropped; their
     * waiting episodes are held briefly so a block re-reported right after the
     * reconnect is the same episode, not a fresh notice.
     */
    private fun onRegistryOpen(nodeUrl: String, identityGen: Int) {
        if (c.identity.generation() != identityGen) return
        val dropped = statusBlocks[nodeUrl]?.reset().orEmpty()
        if (dropped.isEmpty()) return
        val keys = _state.value.items
            .filter { it.nodeDenUrl.trimEnd('/') == nodeUrl && it.item.sessionId in dropped }
            .map { it.item.key }
        needsEpisodes.hold(keys, System.currentTimeMillis() + RECONNECT_BLOCK_GRACE_MS)
        rebuildItems()
    }

    private fun onRegistry(nodeUrl: String, event: HarnessEvent, identityGen: Int) {
        if (c.identity.generation() != identityGen) return
        when (event) {
            is HarnessEvent.SessionCreated -> {
                finishedTurns.onStatus(event.sessionId, event.summary.status, event.supersedes)
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
                        migrateLocalKeys(rekey.from, rekey.to)
                        pointers.rekey(rekey.from, rekey.to)
                        viewModelScope.launch {
                            persistPointers()
                            c.settings.rekeySessionMode(rekey.from, rekey.to)
                        }
                    }
                }
                rebuildItems()
            }
            is HarnessEvent.Status -> {
                val blocks = statusBlocks.getOrPut(nodeUrl) { StatusBlocks() }
                if (blocks.onStatus(event.sessionId, event.status, event.source)) rebuildItems()
            }
            is HarnessEvent.SessionUpdated -> {
                if (finishedTurns.onStatus(event.sessionId, event.status, event.previousSessionId)) {
                    notifyAgentFinished(event.sessionId)
                    // rh files a session after its first summary, and sends no notice for it.
                    loadTopics()
                }
                val blocksMoved = statusBlocks[nodeUrl]
                    ?.onSessionUpdated(event.sessionId, event.status, event.previousSessionId) == true
                val buckets = plane[nodeUrl]
                if (buckets == null) {
                    if (blocksMoved) rebuildItems()
                    return
                }
                var changed = blocksMoved
                for ((hid, result) in buckets.toList()) {
                    val list = result.getOrNull() ?: continue
                    val next = applyRegistryEvent(
                        list,
                        "session-updated",
                        event.sessionId,
                        previousSessionId = event.previousSessionId,
                        status = event.status,
                        blocked = event.blocked,
                    ) ?: continue
                    if (next !== list) {
                        buckets[hid] = Result.success(next)
                        changed = true
                    }
                }
                val prev = event.previousSessionId
                if (prev != null && prev != event.sessionId) {
                    migrateLocalKeys(prev, event.sessionId)
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
            for (item in withStatusBlocks(items, statusBlocks[url])) {
                located += locate(item, node.id, node.name.ifBlank { node.id }, node.denUrl)
            }
        }
        for (d in drafts) {
            if (d.nodeDenUrl.trimEnd('/') in seen) continue
            val pins = pinChatItems(pointers.all(), agents, d.nodeDenUrl)
            val items = chatItems(emptyMap(), emptyList(), listOf(d.id), mapOf(d.id to d.createdAt), pins)
            for (item in items) located += locate(item, d.nodeId, d.nodeName, d.nodeDenUrl)
        }
        val sorted = sortLocatedByRecency(located)
        // Needs you: every rebuild reconciles the waiting set. Until the first
        // full refresh has landed, sessions already waiting are primed, not
        // announced (no burst of notices at launch).
        // A node is settled only after a rebuild that already held its roster,
        // so a node that times out at launch and lands later primes its
        // waiting sessions instead of announcing them all.
        val waiting = sorted.filter { it.item.blocked }
        val waitingItems = waiting.map { it.item }
        val nodeOf = waiting.associate { it.item.key to it.nodeDenUrl.trimEnd('/') }
        val fresh = needsEpisodes.reconcile(
            blocked = waitingItems.map { it.key }.toSet(),
            now = System.currentTimeMillis(),
            ready = rosterSettled,
            present = sorted.map { it.item.key }.toSet(),
            settled = { id -> nodeOf[id] in settledNodes },
        )
        if (rosterSettled) settledNodes += landedNodes
        _state.update { it.copy(items = sorted, needsYou = waitingRows(waitingItems, needsEpisodes.since)) }
        fresh.forEach(::notifyNeedsYou)
    }

    /** Settings → General "When an agent needs you": a conversation started waiting. */
    private fun notifyNeedsYou(sessionId: String) {
        runNotificationHook(onError = { logHookFailure("needs you", it) }) {
            val st = _state.value
            if (!shouldNotifySession(st.prefs.needsYouNotifications, appResumed(), sessionId, openSessionKey())) {
                return@runNotificationHook
            }
            val item = io.rivethub.app.plane.findChatItem(st.items.map { it.item }, sessionId)
            val title = item?.let { io.rivethub.app.plane.displayTitle(it, st.titleOverrides) }
            systemNotifier?.post(
                InboxEntry(
                    id = "$INBOX_KIND_NEEDS_YOU:$sessionId",
                    kind = INBOX_KIND_NEEDS_YOU,
                    title = needsYouTitle,
                    body = agentFinishedBody(title, sessionId),
                    atMs = System.currentTimeMillis(),
                    sessionId = sessionId,
                ),
            )
        }
    }

    /**
     * Open, keep, or swap the ONE notifications socket — the single place it
     * changes. Keyed by the saved entry URL + identity generation, never by
     * discovery (plane/NotificationsWatch.kt reconcileNotificationsWatch): an
     * identity bump or an entry change closes the old socket and opens a new
     * one under a new generation; a different entry node also empties the
     * inbox. No replay — reopening is not a catch-up. Main thread only (the
     * prefs collector and refreshOnce both run on viewModelScope).
     */
    private fun reconcileNotificationWatch(entryUrl: String, identityGen: Int) {
        val step = reconcileNotificationsWatch(notifWatch, notificationsWatchKey(entryUrl, identityGen))
        if (step.watch == notifWatch) return
        // step.close mirrors notifSocket != null; closing by the handle keeps
        // the two from ever disagreeing.
        notifSocket?.close()
        notifSocket = null
        notifWatch = step.watch
        if (step.clearInbox) clearInbox()
        val key = step.open ?: return
        val gen = step.watch.gen
        // Opened against the key's URL, not transport.entry(): the prefs
        // emission can land before the transport is retargeted. A malformed
        // URL must not fail the caller; the next reconcile retries (same key,
        // socketOpen false).
        notifSocket = runCatching {
            c.transport.gateway(NodeRef(id = "", name = "", denUrl = key.entryUrl, online = true, fromMesh = false))
                .watchNotifications(onFrame = { frame -> notifFrames.trySend(NotifMail(gen, frame)) })
        }.getOrNull()
        notifWatch = notificationsWatchOpened(notifWatch, notifSocket != null)
    }

    private fun onNotification(gen: Int, frame: NotificationFrame) {
        if (!acceptNotificationFrame(notifWatch, gen)) return // from a socket we already replaced
        val entry = inboxEntryFor(frame, inboxLabels, System.currentTimeMillis()) ?: return
        val before = _state.value.inbox
        val next = pushInbox(before, entry)
        if (next === before) return // duplicate (second den, or re-delivery)
        _state.update { it.copy(inbox = next, unread = unreadCount(next)) }
        if (frame is NotificationFrame.TaskDone) {
            // This runs on the ONE frame-reading coroutine: a throw from a hook
            // or the OS post would end it and freeze the inbox until the VM is
            // cleared. Log and carry on (cancellation still propagates).
            runNotificationHook(onError = { logHookFailure("onTaskDone", it) }) {
                onTaskDone?.invoke(frame.taskId)
            }
            runNotificationHook(onError = { logHookFailure("system notification", it) }) {
                if (shouldPostSystemNotification(entry, appResumed(), _state.value.prefs.taskNotifications)) {
                    systemNotifier?.post(entry)
                }
            }
        }
    }

    /** Settings → General "When an agent finishes a reply" (rivethub-web lib/turn-finished.ts). */
    private fun notifyAgentFinished(sessionId: String) {
        runNotificationHook(onError = { logHookFailure("agent finished", it) }) {
            val st = _state.value
            if (!shouldNotifyAgentFinished(st.prefs.agentFinishedNotifications, appResumed(), sessionId, openSessionKey())) {
                return@runNotificationHook
            }
            val item = io.rivethub.app.plane.findChatItem(st.items.map { it.item }, sessionId)
            val title = item?.let { io.rivethub.app.plane.displayTitle(it, st.titleOverrides) }
            systemNotifier?.post(
                InboxEntry(
                    // One notice per conversation: a later reply replaces it (systemNotificationId).
                    id = "$INBOX_KIND_AGENT_FINISHED:$sessionId",
                    kind = INBOX_KIND_AGENT_FINISHED,
                    title = agentFinishedTitle,
                    body = agentFinishedBody(title, sessionId),
                    atMs = System.currentTimeMillis(),
                    sessionId = sessionId,
                ),
            )
        }
    }

    private fun logHookFailure(what: String, e: Exception) {
        AndroidLogger.warn("RivetHub", "notification $what failed: ${e.javaClass.simpleName}: ${e.message}", e)
    }

    private fun closeNotificationWatch() {
        notifSocket?.close()
        notifSocket = null
        notifWatch = closeNotificationsWatch(notifWatch)
    }

    private fun closeWatches() {
        watches.values.forEach { it.close() }
        watches.clear()
        watchStatus.clear()
        _state.update { it.copy(registryOpen = false) }
    }

    /** Den URL → `/healthz.node`, kept across refreshes (hub state keys by node id). */
    private val nodeIds = java.util.concurrent.ConcurrentHashMap<String, String>()

    /** The den URL this phone uses for hub state node [nodeId], once discovery has seen it. */
    fun denUrlForNode(nodeId: String): String? = nodeIds.entries.firstOrNull { it.value == nodeId }?.key

    /** Every listed session on one node → that node's id, for hub state keys. */
    private fun sessionNodesOf(bundle: NodeBundle): Map<String, String> = buildMap {
        bundle.planeRows.values.forEach { rows -> rows.getOrNull()?.forEach { put(it.sessionId, bundle.meshNode) } }
        bundle.legacyRows.getOrNull()?.forEach { put(it.id, bundle.meshNode) }
    }

    private data class NodeBundle(
        val node: NodeRef,
        val desc: List<HarnessDescriptor>,
        val planeRows: Map<String, Result<List<HarnessSessionSummary>>>,
        val legacyRows: Result<List<LegacyHarnessSession>>,
        val ok: Boolean,
        val error: String?,
        val presets: Result<List<AgentPreset>>,
        /** `Healthz.node` for this den. Empty when the field is missing or the probe failed. */
        val meshNode: String = "",
        val directoryRoot: String? = null,
    )

}

/** Per-refresh roster extras. Not kept across refreshes. */
private class RosterMeta {
    val meshNodes = HashMap<String, String>()
    var directoryRoot: String? = null
}

/**
 * Hint for one discovered node. `meshNode` is the healthz name when the den
 * sent one, otherwise the mesh id, then the mesh name.
 */
private fun hintFor(node: NodeRef, meta: RosterMeta): AgentNodeHint {
    val reported = meta.meshNodes[node.denUrl.trimEnd('/')].orEmpty()
    val fallback = node.id.ifBlank { node.name }
    return AgentNodeHint(
        id = node.id,
        name = node.name.ifBlank { node.id },
        denUrl = node.denUrl,
        online = node.online,
        meshNode = reported.ifBlank { fallback },
    )
}
