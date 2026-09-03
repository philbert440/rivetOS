package io.rivethub.app.ui

import androidx.compose.runtime.mutableStateListOf
import io.rivethub.app.domain.Bot

sealed interface Screen {
    data object SignIn : Screen
    data object Enroll : Screen
    data object Home : Screen
    data class Chat(val bot: Bot) : Screen
    data class Computer(val bot: Bot, val sessionId: String) : Screen
    data class Profile(val bot: Bot) : Screen
    data class EditBot(val bot: Bot) : Screen
    data object Settings : Screen
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
