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

/**
 * RGBA plane → packed ARGB pixels for ZXing. CameraX
 * [androidx.camera.core.ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888] is this
 * layout: pixelStride 4, rowStride may pad. The buffer is read from its
 * current position. Returns null when the buffer is shorter than the plane.
 */
fun rgbaPixels(
    buffer: ByteBuffer,
    width: Int,
    height: Int,
    rowStride: Int,
    pixelStride: Int,
): IntArray? {
    if (width <= 0 || height <= 0 || pixelStride < 3 || rowStride <= 0) return null
    if (width * pixelStride > rowStride) return null
    val view = buffer.duplicate()
    val base = view.position()
    val needed = (height - 1) * rowStride + width * pixelStride
    if (view.remaining() < needed) return null
    val out = IntArray(width * height)
    for (y in 0 until height) {
        val row = base + y * rowStride
        for (x in 0 until width) {
            val i = row + x * pixelStride
            val r = view.get(i).toInt() and 0xff
            val g = view.get(i + 1).toInt() and 0xff
            val b = view.get(i + 2).toInt() and 0xff
            out[y * width + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }
    }
    return out
}
