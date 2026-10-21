package io.rivethub.app.transport

import org.junit.Assert.assertEquals
import org.junit.Test

class DirectTransportTest {
    private val lan = "https://192.168.0.183:5174"
    private val tailnet = "https://arctic.tail0c3020.ts.net:5174"
    private val nodes = listOf(
        NodeRef(id = "arctic", name = "arctic", denUrl = lan, online = true),
        NodeRef(id = "nuc", name = "nuc", denUrl = "https://192.168.0.50:5174", online = true),
    )

    @Test fun `the entry node takes the entry url`() {
        val out = DirectTransport.withEntryUrl(nodes, "arctic", "$tailnet/")
        assertEquals(listOf(tailnet, "https://192.168.0.50:5174"), out.map { it.denUrl })
    }

    @Test fun `an unknown or blank entry node leaves the mesh urls`() {
        assertEquals(nodes, DirectTransport.withEntryUrl(nodes, "", tailnet))
        assertEquals(nodes, DirectTransport.withEntryUrl(nodes, "laptop", tailnet))
        assertEquals(nodes, DirectTransport.withEntryUrl(nodes, "arctic", " "))
    }
}
