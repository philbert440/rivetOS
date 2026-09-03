package io.rivethub.app.ui

import androidx.compose.runtime.mutableStateListOf

sealed interface Screen {
    data object Enroll : Screen
    data object Hub : Screen
    data class Chat(
        val sessionKey: String,
        val nodeDenUrl: String,
        val harnessId: String?,
        val title: String,
        val draft: Boolean,
        val model: String = "",
        val effort: String = "",
        val agentId: String = "",
    ) : Screen
    data object Gallery : Screen
}

/** Hand-rolled back stack — a handful of screens don't justify a navigation library. */
class Nav(start: Screen) {
    val stack = mutableStateListOf<Screen>(start)
    val current: Screen get() = stack.last()
    fun push(s: Screen) { if (stack.last() != s) stack.add(s) }
    fun pop(): Boolean { if (stack.size <= 1) return false; stack.removeAt(stack.lastIndex); return true }
    fun replaceAll(s: Screen) { stack.clear(); stack.add(s) }
    fun popTo(pred: (Screen) -> Boolean) { while (stack.size > 1 && !pred(stack.last())) stack.removeAt(stack.lastIndex) }
}
