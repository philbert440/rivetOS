package io.rivethub.app.ui.components

import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import io.rivethub.app.R
import io.rivethub.app.plane.yLuminance
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/**
 * Full-screen camera view that reads QR codes (CameraX preview + ZXing on the
 * luminance plane). The first code passing [accept] is handed to [onCode] once;
 * any other QR code swaps the hint for "not a pairing code" and scanning
 * continues. [onCameraError] gets the reason when no camera can be bound.
 * Needs CAMERA already granted.
 */
@Composable
fun PairingScannerDialog(
    accept: (String) -> Boolean,
    onCode: (String) -> Unit,
    onCameraError: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = RivetTheme.colors
    var sawOtherCode by remember { mutableStateOf(false) }
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(Modifier.fillMaxSize().background(colors.bg)) {
            QrCameraView(
                accept = accept,
                onCode = onCode,
                onOtherCode = { sawOtherCode = true },
                onCameraError = onCameraError,
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                Modifier
                    .align(Alignment.Center)
                    .size(240.dp)
                    .border(2.dp, colors.em, RoundedCornerShape(12.dp)),
            )
            Text(
                stringResource(if (sawOtherCode) R.string.pair_not_code else R.string.pair_scan_hint),
                color = colors.ink,
                style = RivetType.sm,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .statusBarsPadding()
                    .background(colors.bg.copy(alpha = 0.8f), RoundedCornerShape(8.dp))
                    .padding(horizontal = 16.dp, vertical = 12.dp),
            )
            RivetButton(
                text = stringResource(R.string.action_cancel),
                onClick = onDismiss,
                variant = RivetButtonVariant.Outline,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(24.dp)
                    .fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun QrCameraView(
    accept: (String) -> Boolean,
    onCode: (String) -> Unit,
    onOtherCode: () -> Unit,
    onCameraError: (String) -> Unit,
    modifier: Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val acceptNow by rememberUpdatedState(accept)
    val onCodeNow by rememberUpdatedState(onCode)
    val onOtherCodeNow by rememberUpdatedState(onOtherCode)
    val onCameraErrorNow by rememberUpdatedState(onCameraError)
    // TextureView, not the default SurfaceView: a SurfaceView inside this
    // dialog punches a hole and the preview never appears, so aiming is blind.
    val previewView = remember {
        PreviewView(context).apply {
            implementationMode = PreviewView.ImplementationMode.COMPATIBLE
            scaleType = PreviewView.ScaleType.FILL_CENTER
        }
    }

    DisposableEffect(lifecycleOwner) {
        val executor = Executors.newSingleThreadExecutor()
        val done = AtomicBoolean(false)
        // Set on dispose: a provider that resolves after Cancel must not bind.
        val disposed = AtomicBoolean(false)
        val sawOther = AtomicBoolean(false)
        // One scrambled frame must not stick the "not a pairing code" hint.
        val lastOther = AtomicReference<String?>(null)
        val reader = QRCodeReader()
        val hints = mapOf(DecodeHintType.TRY_HARDER to true)
        val main = ContextCompat.getMainExecutor(context)
        val providerFuture = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null

        val analysis = ImageAnalysis.Builder()
            .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
            .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_YUV_420_888)
            .build()
        analysis.setAnalyzer(executor) { image ->
            image.use {
                if (done.get()) return@use
                val text = decodeQr(reader, hints, it) ?: return@use
                if (!acceptNow(text)) {
                    val repeat = lastOther.getAndSet(text) == text
                    if (repeat && sawOther.compareAndSet(false, true)) main.execute { onOtherCodeNow() }
                } else if (done.compareAndSet(false, true)) {
                    main.execute { onCodeNow(text) }
                }
            }
        }

        providerFuture.addListener({
            if (disposed.get()) return@addListener
            try {
                val p = providerFuture.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = previewView.surfaceProvider }
                p.unbindAll()
                // Throws on a device with no back camera (the manifest does not require one).
                p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                provider = p
            } catch (e: Exception) {
                if (!disposed.get()) onCameraErrorNow(e.message ?: e.javaClass.simpleName)
            }
        }, main)

        onDispose {
            disposed.set(true)
            done.set(true)
            provider?.unbindAll()
            executor.shutdown()
        }
    }

    AndroidView(factory = { previewView }, modifier = modifier)
}

/** Y plane → ZXing; retries inverted so light-on-dark terminal QRs read too. */
private fun decodeQr(reader: QRCodeReader, hints: Map<DecodeHintType, Any>, image: ImageProxy): String? {
    val plane = image.planes.firstOrNull() ?: return null
    val packed = try {
        yLuminance(plane.buffer, image.width, image.height, plane.rowStride, plane.pixelStride)
    } catch (_: Exception) {
        null
    } ?: return null
    val source = try {
        PlanarYUVLuminanceSource(packed, image.width, image.height, 0, 0, image.width, image.height, false)
    } catch (_: IllegalArgumentException) {
        return null
    }
    for (candidate in listOf(source, source.invert())) {
        try {
            return reader.decode(BinaryBitmap(HybridBinarizer(candidate)), hints).text
        } catch (_: ReaderException) {
            // not in this frame
        } finally {
            reader.reset()
        }
    }
    return null
}
