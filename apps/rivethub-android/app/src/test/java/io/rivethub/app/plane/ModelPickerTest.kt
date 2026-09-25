package io.rivethub.app.plane

import io.rivethub.app.gateway.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelPickerTest {
    private val models = listOf(
        ModelOption("alpha-1", "Alpha One", default = true),
        ModelOption("beta-2", "Beta Two"),
        ModelOption("gamma-3", "Gamma Three"),
    )

    private fun ids(g: ModelGroup): List<String> = g.options.map { it.id }

    @Test
    fun `no favourites yields only the all group in sheet order`() {
        val groups = groupModels(models, emptySet(), "Favourites", "All models")
        assertEquals(1, groups.size)
        assertEquals("All models", groups[0].label)
        assertEquals(listOf("alpha-1", "beta-2", "gamma-3"), ids(groups[0]))
    }

    @Test
    fun `favourites group comes first in favourite order and all keeps sheet order`() {
        val favs = linkedSetOf("gamma-3", "alpha-1")
        val groups = groupModels(models, favs, "Favourites", "All models")
        assertEquals(listOf("Favourites", "All models"), groups.map { it.label })
        assertEquals(listOf("gamma-3", "alpha-1"), ids(groups[0]))
        assertEquals(listOf("alpha-1", "beta-2", "gamma-3"), ids(groups[1]))
    }

    @Test
    fun `favourite ids the sheet no longer lists are skipped`() {
        val groups = groupModels(models, setOf("retired-0"), "Favourites", "All models")
        assertEquals(listOf("All models"), groups.map { it.label })
        val mixed = groupModels(models, linkedSetOf("retired-0", "beta-2"), "Favourites", "All models")
        assertEquals(listOf("beta-2"), ids(mixed[0]))
    }

    @Test
    fun `empty sheet yields no groups`() {
        assertTrue(groupModels(emptyList(), setOf("alpha-1"), "Favourites", "All models").isEmpty())
    }

    @Test
    fun `filter matches label case-insensitively`() {
        val groups = groupModels(models, emptySet(), "Favourites", "All models")
        val out = filterModels(groups, "tWo")
        assertEquals(1, out.size)
        assertEquals(listOf("beta-2"), ids(out[0]))
    }

    @Test
    fun `filter matches id`() {
        val groups = groupModels(models, emptySet(), "Favourites", "All models")
        val out = filterModels(groups, "GAMMA-3")
        assertEquals(listOf("gamma-3"), ids(out[0]))
    }

    @Test
    fun `filter drops groups left empty`() {
        val groups = groupModels(models, setOf("alpha-1"), "Favourites", "All models")
        val out = filterModels(groups, "beta")
        assertEquals(listOf("All models"), out.map { it.label })
        assertEquals(listOf("beta-2"), ids(out[0]))
        assertTrue(filterModels(groups, "zzz").isEmpty())
    }

    @Test
    fun `blank filter keeps every group`() {
        val groups = groupModels(models, setOf("alpha-1"), "Favourites", "All models")
        assertEquals(groups, filterModels(groups, "  "))
    }

    @Test
    fun `toggle adds at the end and removes when present`() {
        val one = toggleFavourite(emptySet(), "beta-2")
        assertEquals(listOf("beta-2"), one.toList())
        val two = toggleFavourite(one, "alpha-1")
        assertEquals(listOf("beta-2", "alpha-1"), two.toList())
        val back = toggleFavourite(two, "beta-2")
        assertEquals(listOf("alpha-1"), back.toList())
        assertEquals(two, toggleFavourite(two, " "))
    }
}
