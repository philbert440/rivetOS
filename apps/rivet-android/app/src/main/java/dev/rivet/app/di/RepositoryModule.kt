package dev.rivet.app.di

import dev.rivet.app.data.files.FilesManager
import dev.rivet.app.data.files.SkillManager
import dev.rivet.app.data.repository.ConversationRepository
import dev.rivet.app.data.repository.FavoriteRepository
import dev.rivet.app.data.repository.FilesRepository
import dev.rivet.app.data.repository.GenMediaRepository
import dev.rivet.app.data.repository.MemoryRepository
import org.koin.dsl.module

val repositoryModule = module {
    single {
        ConversationRepository(get(), get(), get(), get(), get(), get())
    }

    single {
        MemoryRepository(get())
    }

    single {
        GenMediaRepository(get())
    }

    single {
        FilesRepository(get())
    }

    single {
        FavoriteRepository(get())
    }

    single {
        FilesManager(get(), get(), get())
    }

    single {
        SkillManager(get(), get())
    }
}
