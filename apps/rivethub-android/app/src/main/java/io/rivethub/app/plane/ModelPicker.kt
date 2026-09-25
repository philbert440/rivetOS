package io.rivethub.app.plane

import io.rivethub.app.gateway.ModelOption

/**
 * One section of the composer model sheet (UX-SPEC §4): a Favourites group
 * first, then every model the harness sheet lists. Options are the sheet's own
 * [ModelOption]s — `plane/` never depends on `ui/`, so the Compose
 * `SelectOption` is not used here; the sheet renders `id` + `label` directly.
 */
data class ModelGroup(val label: String, val options: List<ModelOption>)

/**
 * Favourites group (only when at least one favourite is still offered by the
 * sheet, in favourite order) followed by the full list in sheet order. A
 * favourite id the sheet no longer lists is skipped, never invented.
 */
fun groupModels(
    models: List<ModelOption>,
    favourites: Set<String>,
    groupLabelFavourites: String,
    groupLabelAll: String,
): List<ModelGroup> {
    if (models.isEmpty()) return emptyList()
    val byId = models.associateBy { it.id }
    val favs = favourites.mapNotNull { byId[it] }
    return buildList {
        if (favs.isNotEmpty()) add(ModelGroup(groupLabelFavourites, favs))
        add(ModelGroup(groupLabelAll, models))
    }
}

/**
 * Case-insensitive substring match over label and id. A blank query keeps
 * every option. Groups left without options are dropped.
 */
fun filterModels(groups: List<ModelGroup>, query: String): List<ModelGroup> {
    val q = query.trim().lowercase()
    return groups.mapNotNull { g ->
        val kept = if (q.isEmpty()) {
            g.options
        } else {
            g.options.filter { it.label.lowercase().contains(q) || it.id.lowercase().contains(q) }
        }
        if (kept.isEmpty()) null else g.copy(options = kept)
    }
}

/** Add [id] at the end of the favourite order, or remove it if present. Blank ids are ignored. */
fun toggleFavourite(favs: Set<String>, id: String): Set<String> {
    if (id.isBlank()) return favs
    val next = LinkedHashSet(favs)
    if (!next.remove(id)) next.add(id)
    return next
}
