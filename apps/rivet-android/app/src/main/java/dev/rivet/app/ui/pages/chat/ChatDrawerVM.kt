package dev.rivet.app.ui.pages.chat

import android.app.Application
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.paging.PagingData
import androidx.paging.cachedIn
import androidx.paging.insertSeparators
import androidx.paging.map
import dev.rivet.app.R
import dev.rivet.app.data.datastore.NodeRosterDefaults
import dev.rivet.app.data.datastore.SettingsStore
import dev.rivet.app.data.model.Conversation
import dev.rivet.app.data.repository.ConversationRepository
import dev.rivet.app.service.ChatService
import dev.rivet.app.utils.toLocalString
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.map
import kotlin.uuid.Uuid

@OptIn(ExperimentalCoroutinesApi::class)
class ChatDrawerVM(
    private val context: Application,
    private val settingsStore: SettingsStore,
    private val conversationRepo: ConversationRepository,
    private val chatService: ChatService,
    private val savedStateHandle: SavedStateHandle,
) : ViewModel() {

    /**
     * Local node → Room paging (phone-owned chats).
     * Remote node → den harness sessions (node+harness scoped history).
     */
    val conversations: Flow<PagingData<ConversationListItem>> =
        settingsStore.settingsFlow
            .map { settings ->
                val den = settings.activeNodeDenUrl.ifBlank { NodeRosterDefaults.localDenUrl() }
                Triple(settings.assistantId, den, !NodeRosterDefaults.isLocalDenUrl(den))
            }
            .distinctUntilChanged()
            .flatMapLatest { (assistantId, den, remote) ->
                if (!remote) {
                    conversationRepo.getConversationsOfAssistantPaging(assistantId)
                        .map { pagingData ->
                            pagingData
                                .map { ConversationListItem.Item(it) }
                                .withDateSeparators()
                        }
                } else {
                    flow {
                        // den is only used to trigger refresh on node change; fetch uses
                        // ChatService → activeNodeDenUrl.
                        @Suppress("UNUSED_VARIABLE")
                        val _den = den
                        val sessions = chatService.listRemoteHarnessSessions()
                        val items = sessions.mapNotNull { s ->
                            val id = ChatService.parseHarnessSessionUuid(s.id) ?: return@mapNotNull null
                            val updated = if (s.updatedAt > 0) {
                                Instant.ofEpochMilli(s.updatedAt)
                            } else {
                                Instant.now()
                            }
                            Conversation(
                                id = id,
                                assistantId = assistantId,
                                title = s.title.ifBlank { "${s.command} · ${s.id.take(8)}" },
                                messageNodes = emptyList(),
                                createAt = updated,
                                updateAt = updated,
                            )
                        }
                        emit(
                            PagingData.from(items.map { ConversationListItem.Item(it) })
                                .withDateSeparators(),
                        )
                    }
                }
            }
            .cachedIn(viewModelScope)

    val scrollIndex: Int get() = savedStateHandle["scrollIndex"] ?: 0
    val scrollOffset: Int get() = savedStateHandle["scrollOffset"] ?: 0

    fun saveScrollPosition(index: Int, offset: Int) {
        savedStateHandle["scrollIndex"] = index
        savedStateHandle["scrollOffset"] = offset
    }

    /**
     * On remote: import harness transcript into Room (join key = session id), then navigate.
     * On local: just return the id.
     */
    suspend fun prepareOpenConversation(conversation: Conversation): Uuid {
        val settings = settingsStore.settingsFlowRaw.first()
        val den = settings.activeNodeDenUrl
        if (den.isBlank() || NodeRosterDefaults.isLocalDenUrl(den)) {
            return conversation.id
        }
        val imported = chatService.importHarnessSession(
            sessionId = conversation.id.toString(),
            titleHint = conversation.title,
        )
        return imported?.id ?: conversation.id
    }

    private fun getDateLabel(date: LocalDate): String {
        val today = LocalDate.now()
        val yesterday = today.minusDays(1)
        return when (date) {
            today -> context.getString(R.string.chat_page_today)
            yesterday -> context.getString(R.string.chat_page_yesterday)
            else -> date.toLocalString(date.year != today.year)
        }
    }

    private fun PagingData<ConversationListItem.Item>.withDateSeparators(): PagingData<ConversationListItem> =
        insertSeparators { before, after ->
            when {
                before == null && after != null -> {
                    if (after.conversation.isPinned) {
                        ConversationListItem.PinnedHeader
                    } else {
                        val afterDate = after.conversation.updateAt
                            .atZone(ZoneId.systemDefault())
                            .toLocalDate()
                        ConversationListItem.DateHeader(
                            date = afterDate,
                            label = getDateLabel(afterDate),
                        )
                    }
                }

                before != null && after != null -> {
                    if (before.conversation.isPinned && !after.conversation.isPinned) {
                        val afterDate = after.conversation.updateAt
                            .atZone(ZoneId.systemDefault())
                            .toLocalDate()
                        ConversationListItem.DateHeader(
                            date = afterDate,
                            label = getDateLabel(afterDate),
                        )
                    } else if (!after.conversation.isPinned) {
                        val beforeDate = before.conversation.updateAt
                            .atZone(ZoneId.systemDefault())
                            .toLocalDate()
                        val afterDate = after.conversation.updateAt
                            .atZone(ZoneId.systemDefault())
                            .toLocalDate()
                        if (beforeDate != afterDate) {
                            ConversationListItem.DateHeader(
                                date = afterDate,
                                label = getDateLabel(afterDate),
                            )
                        } else {
                            null
                        }
                    } else {
                        null
                    }
                }

                else -> null
            }
        }
}
