package dev.rivet.app.di

import dev.rivet.app.ui.pages.assistant.AssistantVM
import dev.rivet.app.ui.pages.assistant.detail.AssistantDetailVM
import dev.rivet.app.ui.pages.backup.BackupVM
import dev.rivet.app.ui.pages.chat.ChatDrawerVM
import dev.rivet.app.ui.pages.chat.ChatVM
import dev.rivet.app.ui.pages.debug.DebugVM
import dev.rivet.app.ui.pages.developer.DeveloperVM
import dev.rivet.app.ui.pages.favorite.FavoriteVM
import dev.rivet.app.ui.pages.search.SearchVM
import dev.rivet.app.ui.pages.history.HistoryVM
import dev.rivet.app.ui.pages.imggen.ImgGenVM
import dev.rivet.app.ui.pages.setting.SettingVM
import dev.rivet.app.ui.pages.share.handler.ShareHandlerVM
import org.koin.core.module.dsl.viewModel
import org.koin.core.module.dsl.viewModelOf
import org.koin.dsl.module

val viewModelModule = module {
    viewModel<ChatVM> { params ->
        ChatVM(
            id = params.get(),
            context = get(),
            settingsStore = get(),
            conversationRepo = get(),
            chatService = get(),
            filesManager = get(),
            favoriteRepository = get(),
        )
    }
    viewModelOf(::ChatDrawerVM)
    viewModelOf(::SettingVM)
    viewModelOf(::DebugVM)
    viewModelOf(::HistoryVM)
    viewModelOf(::AssistantVM)
    viewModel<AssistantDetailVM> {
        AssistantDetailVM(
            id = it.get(),
            settingsStore = get(),
            memoryRepository = get(),
            filesManager = get(),
            skillManager = get(),
        )
    }
    viewModel<ShareHandlerVM> {
        ShareHandlerVM(
            text = it.get(),
            settingsStore = get(),
        )
    }
    viewModelOf(::BackupVM)
    viewModelOf(::ImgGenVM)
    viewModelOf(::DeveloperVM)
    viewModelOf(::FavoriteVM)
    viewModelOf(::SearchVM)
}
