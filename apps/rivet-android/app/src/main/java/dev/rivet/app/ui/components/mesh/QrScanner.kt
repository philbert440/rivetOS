package dev.rivet.app.ui.components.mesh

import android.util.Log
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Live camera QR scanner. Emits the first decoded QR whose text passes
 * [accept] exactly once, then stops feeding frames (parent dismisses the
 * sheet). CameraX + ML Kit; both are already app dependencies.
 */
@OptIn(ExperimentalGetImage::class)
@Composable
fun QrScanner(
    onScanned: (String) -> Unit,
    accept: (String) -> Boolean,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current

    Box(modifier = modifier.fillMaxWidth().height(300.dp)) {
        AndroidView(
            factory = { ctx ->
                val previewView = PreviewView(ctx)
                val executor = Executors.newSingleThreadExecutor()
                val scanner = BarcodeScanning.getClient()
                val done = AtomicBoolean(false)

                val providerFuture = ProcessCameraProvider.getInstance(ctx)
                providerFuture.addListener({
                    val provider = providerFuture.get()
                    val preview = Preview.Builder().build().also {
                        it.surfaceProvider = previewView.surfaceProvider
                    }
                    val analysis = ImageAnalysis.Builder()
                        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                        .build()
                    analysis.setAnalyzer(executor) { proxy ->
                        if (done.get()) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        val image = inputImageOf(proxy)
                        if (image == null) {
                            proxy.close()
                            return@setAnalyzer
                        }
                        scanner.process(image)
                            .addOnSuccessListener { codes ->
                                val hit = codes.firstOrNull { b ->
                                    b.format == Barcode.FORMAT_QR_CODE && b.rawValue?.let(accept) == true
                                }
                                if (hit != null && done.compareAndSet(false, true)) {
                                    onScanned(hit.rawValue!!)
                                }
                            }
                            .addOnCompleteListener { proxy.close() }
                    }
                    try {
                        provider.unbindAll()
                        provider.bindToLifecycle(
                            lifecycleOwner,
                            CameraSelector.DEFAULT_BACK_CAMERA,
                            preview,
                            analysis,
                        )
                    } catch (e: Exception) {
                        Log.e("QrScanner", "camera bind failed", e)
                    }
                }, ContextCompat.getMainExecutor(ctx))

                previewView
            },
            modifier = Modifier.fillMaxWidth(),
        )
    }

    // ML Kit / CameraX release their own resources on lifecycle stop; the
    // provider is lifecycle-bound above so nothing to unbind here.
    DisposableEffect(Unit) { onDispose { } }
}

@OptIn(ExperimentalGetImage::class)
private fun inputImageOf(proxy: androidx.camera.core.ImageProxy): InputImage? {
    val media = proxy.image ?: return null
    return InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
}
