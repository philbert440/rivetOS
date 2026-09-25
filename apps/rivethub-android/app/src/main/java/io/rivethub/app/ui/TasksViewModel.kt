package io.rivethub.app.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import io.rivethub.app.AppContainer
import io.rivethub.app.gateway.*
import io.rivethub.app.plane.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class TasksViewModel(private val c: AppContainer) : ViewModel() {
    data class UiState(
        val tasks: List<TaskWire> = emptyList(),
        val loading: Boolean = false,
        val error: String? = null,
        val filter: String = "",
        val catalog: List<CatalogAgent> = emptyList(),
        val detail: TaskWire? = null,
        val detailLoading: Boolean = false,
        val steerText: String = "",
        val detailId: String? = null,
        val acting: Boolean = false,
    )
    private val mutable = MutableStateFlow(UiState())
    val state = mutable.asStateFlow()
    private var listGeneration = 0
    private var detailGeneration = 0

    fun refresh() {
        val generation = ++listGeneration
        val filter = mutable.value.filter.takeIf { it.isNotEmpty() }
        mutable.update { it.copy(loading = true, error = null) }
        viewModelScope.launch {
            try {
                val gateway = c.transport.entry()
                // Each resource gets one attempt, even when the other fails.
                try {
                    val tasks = gateway.tasks(status = filter).tasks
                    if (generation == listGeneration) mutable.update { it.copy(tasks = tasks) }
                } catch (e: Exception) { report(e, generation == listGeneration) }
                try {
                    val catalog = gateway.catalogAgents().agents
                    if (generation == listGeneration) mutable.update { it.copy(catalog = catalog) }
                } catch (e: Exception) { report(e, generation == listGeneration) }
            } catch (e: Exception) { report(e, generation == listGeneration) }
            finally { if (generation == listGeneration) mutable.update { it.copy(loading = false) } }
        }
    }

    fun loadCatalog() {
        viewModelScope.launch {
            try {
                val catalog = c.transport.entry().catalogAgents().agents
                mutable.update { it.copy(catalog = catalog) }
            } catch (e: Exception) { report(e) }
        }
    }

    fun open(id: String) {
        val generation = ++detailGeneration
        mutable.update { it.copy(detailId = id, detail = null,
            detailLoading = true, error = null, steerText = if (it.detailId == id) it.steerText else "") }
        viewModelScope.launch {
            try {
                val task = c.transport.entry().task(id).task
                if (generation == detailGeneration) mutable.update { it.copy(detail = task) }
            } catch (e: Exception) { report(e, generation == detailGeneration) }
            finally { if (generation == detailGeneration) mutable.update { it.copy(detailLoading = false) } }
        }
    }

    fun setFilter(filter: String) {
        if (mutable.value.filter == filter) return
        mutable.update { it.copy(filter = filter) }
        refresh()
    }
    fun setSteerText(text: String) { mutable.update { it.copy(steerText = text) } }

    fun create(goal: String, agentId: String, criteriaText: String, onCreated: (String) -> Unit) {
        val trimmed = delegateGoalFromComposer(goal) ?: return
        if (taskAgentOptions(mutable.value.catalog).none { it.id == agentId && it.enabled }) return
        act {
            val task = c.transport.entry().taskCreate(TaskCreateRequest(trimmed, agentId,
                criteriaFromLines(criteriaText).takeIf { it.isNotEmpty() })).task
            refresh()
            onCreated(task.id)
        }
    }
    fun steer(id: String, message: String) {
        if (message.isBlank() || taskIsTerminal(mutable.value.detail?.status.orEmpty())) return
        act {
            c.transport.entry().taskSteer(id, message.trim())
            if (mutable.value.detailId == id) mutable.update { it.copy(steerText = "") }
            refresh()
            open(id)
        }
    }
    fun kill(id: String) {
        if (taskIsTerminal(mutable.value.detail?.status.orEmpty())) return
        act {
            c.transport.entry().taskKill(id)
            refresh()
            open(id)
        }
    }
    private fun act(block: suspend () -> Unit) {
        if (mutable.value.acting) return
        mutable.update { it.copy(acting = true, error = null) }
        viewModelScope.launch {
            try { block() }
            catch (e: Exception) { report(e) }
            finally { mutable.update { it.copy(acting = false) } }
        }
    }
    private fun report(e: Exception, current: Boolean = true) {
        if (e is CancellationException) throw e
        if (current) mutable.update { it.copy(error = e.message ?: e.javaClass.simpleName) }
    }
}
