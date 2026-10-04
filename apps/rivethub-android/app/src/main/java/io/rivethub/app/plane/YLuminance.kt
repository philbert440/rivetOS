package io.rivethub.app.plane

import java.nio.ByteBuffer

/**
 * Pack a camera Y plane into tightly packed 8-bit luminance for ZXing.
 *
 * The buffer is read from its current position. Do not rewind it: CameraX
 * puts the plane at [ByteBuffer.position], which is not always 0.
 * [pixelStride] is 1 for YUV_420_888 and 2 for P010 (Pixel 10 Pro delivers
 * 10-bit samples in little-endian 16-bit words). The high byte is the
 * usable 8 bits. [rowStride] padding is dropped.
 *
 * Returns null when the buffer is shorter than the plane it describes,
 * instead of throwing and killing the analyzer.
 */
fun yLuminance(
    buffer: ByteBuffer,
    width: Int,
    height: Int,
    rowStride: Int,
    pixelStride: Int,
): ByteArray? {
    if (width <= 0 || height <= 0 || pixelStride <= 0 || rowStride <= 0) return null
    // Full samples, including the high byte of a 16-bit P010 pixel.
    val needed = width * pixelStride
    if (needed > rowStride) return null
    val view = buffer.duplicate()
    val out = ByteArray(width * height)
    val row = ByteArray(rowStride)
    for (y in 0 until height) {
        val toRead = if (y == height - 1) needed else rowStride
        if (view.remaining() < toRead) return null
        view.get(row, 0, toRead)
        var x = 0
        var i = 0
        while (x < width) {
            out[y * width + x] = if (pixelStride == 1) row[i] else row[i + pixelStride - 1]
            x++
            i += pixelStride
        }
    }
    return out
}
