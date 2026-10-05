package io.rivethub.app.plane

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.nio.ByteBuffer

class YLuminanceTest {
    @Test fun `a packed 8-bit plane is copied as-is`() {
        val src = byteArrayOf(1, 2, 3, 4, 5, 6)
        val out = yLuminance(ByteBuffer.wrap(src), width = 3, height = 2, rowStride = 3, pixelStride = 1)
        assertArrayEquals(src, out)
    }

    @Test fun `row padding is dropped`() {
        val src = byteArrayOf(1, 2, 9, 9, 3, 4, 9, 9)
        val out = yLuminance(ByteBuffer.wrap(src), width = 2, height = 2, rowStride = 4, pixelStride = 1)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), out)
    }

    @Test fun `p010 keeps the high byte of each little-endian sample`() {
        val src = byteArrayOf(0x01, 0x10, 0x02, 0x20, 0x03, 0x30, 0x04, 0x40)
        val out = yLuminance(ByteBuffer.wrap(src), width = 2, height = 2, rowStride = 4, pixelStride = 2)
        assertArrayEquals(byteArrayOf(0x10, 0x20, 0x30, 0x40), out)
    }

    @Test fun `bytes before the buffer position are not read`() {
        val buf = ByteBuffer.wrap(byteArrayOf(9, 9, 1, 2, 3, 4))
        buf.position(2)
        val out = yLuminance(buf, width = 2, height = 2, rowStride = 2, pixelStride = 1)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), out)
        // The caller's position is left alone.
        org.junit.Assert.assertEquals(2, buf.position())
    }

    @Test fun `a short buffer is refused instead of throwing`() {
        val src = byteArrayOf(1, 2, 3)
        assertNull(yLuminance(ByteBuffer.wrap(src), width = 2, height = 2, rowStride = 2, pixelStride = 1))
    }

    @Test fun `a stride too narrow for the width is refused`() {
        assertNull(yLuminance(ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4)), width = 3, height = 1, rowStride = 2, pixelStride = 1))
    }

    @Test fun `rgba keeps rgb and drops the alpha and the row padding`() {
        // Two pixels, row padded to 12. Position skips a leading junk byte.
        val src = byteArrayOf(
            7,
            0x11, 0x22, 0x33, 0xFF.toByte(), 0x44, 0x55, 0x66, 0x80.toByte(), 9, 9, 9, 9,
        )
        val buf = ByteBuffer.wrap(src)
        buf.position(1)
        val out = rgbaPixels(buf, width = 2, height = 1, rowStride = 12, pixelStride = 4)
        org.junit.Assert.assertNotNull(out)
        org.junit.Assert.assertEquals(0xFF112233.toInt(), out!![0])
        org.junit.Assert.assertEquals(0xFF445566.toInt(), out[1])
        org.junit.Assert.assertEquals(1, buf.position())
    }
}
