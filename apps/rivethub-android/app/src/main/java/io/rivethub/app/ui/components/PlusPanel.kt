package io.rivethub.app.ui.components

import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import io.rivethub.app.R
import io.rivethub.app.plane.PlusItem
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Composer "+" panel (UX-SPEC §4): Photo · Camera · File · Compress context,
 * filtered by `plane/ChatChrome.kt plusPanelItems`. A bottom sheet (same
 * vocabulary as the picker sheets) rather than an anchored popover: it keeps
 * the 44dp rows and the IME-aware sheet host. Compress asks first; the dialog
 * lives outside the sheet so it survives the sheet's dismissal.
 */
@Composable
fun PlusPanel(
    visible: Boolean,
    items: List<PlusItem>,
    onDismiss: () -> Unit,
    onPick: (PlusItem) -> Unit,
) {
    var confirmCompress by remember { mutableStateOf(false) }
    if (visible) {
        RivetModalSheet(onDismiss = onDismiss) {
            items.forEach { item ->
                PlusRow(iconFor(item), labelFor(item)) {
                    onDismiss()
                    if (item == PlusItem.Compress) confirmCompress = true else onPick(item)
                }
            }
        }
    }
    if (confirmCompress) {
        RivetConfirmDialog(
            title = stringResource(R.string.compress_confirm_title),
            message = stringResource(R.string.compress_confirm_body),
            confirmLabel = stringResource(R.string.compress_confirm_action),
            cancelLabel = stringResource(R.string.action_cancel),
            onConfirm = {
                confirmCompress = false
                onPick(PlusItem.Compress)
            },
            onDismiss = { confirmCompress = false },
        )
    }
}

@DrawableRes
private fun iconFor(item: PlusItem): Int = when (item) {
    PlusItem.Photo -> R.drawable.lucide_image
    PlusItem.Camera -> R.drawable.lucide_camera
    PlusItem.File -> R.drawable.lucide_paperclip
    PlusItem.Compress -> R.drawable.lucide_minimize_2
}

@StringRes
private fun labelFor(item: PlusItem): Int = when (item) {
    PlusItem.Photo -> R.string.plus_photo
    PlusItem.Camera -> R.string.plus_camera
    PlusItem.File -> R.string.plus_file
    PlusItem.Compress -> R.string.plus_compress
}

@Composable
private fun PlusRow(@DrawableRes icon: Int, @StringRes label: Int, onClick: () -> Unit) {
    val colors = RivetTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Dimens.touchTarget)
            .clip(RoundedCornerShape(Radius.sm))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Lucide(icon, contentDescription = null, tint = colors.inkDim, modifier = Modifier.size(16.dp))
        Text(stringResource(label), color = colors.ink, style = RivetType.sm)
    }
}

/** Photo-picker and camera entry points for the "+" panel; see [rememberComposerMediaLaunchers]. */
class ComposerMediaLaunchers(
    val pickPhoto: () -> Unit,
    val takePhoto: () -> Unit,
)

/**
 * Registers the Photo (`PickVisualMedia`, images only) and Camera
 * (`TakePicture` into `cacheDir/camera/` shared through the app's
 * FileProvider) launchers. Call it from the screen, not from inside the
 * sheet — a launcher must outlive the sheet it was opened from.
 * [onCaptureStart] / [onCaptureAbandoned] bracket a camera launch by file
 * name so the owner's capture registry can hold it; [onCamera] gets the
 * FileProvider uri and the captured file. Nothing is swept here — the owner
 * sweeps stale captures after a successful stage (`plane/CameraCaptures.kt`).
 */
@Composable
fun rememberComposerMediaLaunchers(
    onPhoto: (Uri) -> Unit,
    onCamera: (uri: Uri, file: File) -> Unit,
    onCaptureStart: (name: String) -> Unit = {},
    onCaptureAbandoned: (name: String) -> Unit = {},
): ComposerMediaLaunchers {
    val ctx = LocalContext.current
    var pendingPath by rememberSaveable { mutableStateOf<String?>(null) }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        uri?.let(onPhoto)
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val file = pendingPath?.let { File(it) }
        pendingPath = null
        if (file == null) return@rememberLauncherForActivityResult
        if (ok && file.length() > 0L) {
            onCamera(cameraUri(ctx, file), file)
        } else {
            file.delete()
            onCaptureAbandoned(file.name)
        }
    }
    return remember(photo, camera, ctx) {
        ComposerMediaLaunchers(
            pickPhoto = {
                photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
            },
            takePhoto = {
                val file = newCameraFile(ctx)
                pendingPath = file.absolutePath
                onCaptureStart(file.name)
                runCatching { camera.launch(cameraUri(ctx, file)) }.onFailure {
                    pendingPath = null
                    file.delete()
                    onCaptureAbandoned(file.name)
                }
            },
        )
    }
}

private const val CAMERA_DIR = "camera"

private fun newCameraFile(ctx: Context): File {
    val dir = File(ctx.cacheDir, CAMERA_DIR).apply { mkdirs() }
    val stamp = SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(Date())
    return File(dir, "photo-$stamp.jpg")
}

private fun cameraUri(ctx: Context, file: File): Uri =
    FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
