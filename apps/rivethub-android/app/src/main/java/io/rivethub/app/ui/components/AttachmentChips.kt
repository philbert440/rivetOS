package io.rivethub.app.ui.components

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import io.rivethub.app.R
import io.rivethub.app.plane.AttachedRef
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

private val THUMB = 72.dp

/**
 * Attachment chips under a user bubble (UX-SPEC §1.3): image types as 72dp
 * thumbnails (tap → full-screen [ImageViewerSheet]), everything else as a
 * file pill with the file name. An image that cannot be loaded falls back to
 * a pill with the image glyph. Right-aligned, wrapping. [onLongPress] (the
 * message's action reveal) is forwarded to thumbnails, whose own tap would
 * otherwise swallow the long-press meant for the bubble container.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AttachmentChips(
    refs: List<AttachedRef>,
    images: AttachmentImageSource?,
    modifier: Modifier = Modifier,
    onLongPress: (() -> Unit)? = null,
) {
    if (refs.isEmpty()) return
    var viewing by remember { mutableStateOf<AttachedRef?>(null) }
    FlowRow(
        modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.End),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        refs.forEach { ref ->
            if (ref.isImage && images != null) {
                ImageThumb(ref, images, onOpen = { viewing = ref }, onLongPress = onLongPress)
            } else {
                FilePill(ref)
            }
        }
    }
    val open = viewing
    if (open != null && images != null) {
        ImageViewerSheet(open, images, onDismiss = { viewing = null })
    }
}

@Composable
private fun ImageThumb(
    ref: AttachedRef,
    images: AttachmentImageSource,
    onOpen: () -> Unit,
    onLongPress: (() -> Unit)?,
) {
    val colors = RivetTheme.colors
    val px = with(LocalDensity.current) { THUMB.roundToPx() }
    val shape = RoundedCornerShape(Radius.lg)
    when (val img = rememberAttachmentImage(ref.uri, px, images)) {
        is AttachmentImage.Ready -> Image(
            bitmap = img.bitmap,
            contentDescription = stringResource(R.string.attachment_image_cd, ref.name),
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(THUMB)
                .clip(shape)
                .border(Dimens.line, colors.line, shape)
                .combinedClickable(
                    role = Role.Image,
                    onClickLabel = stringResource(R.string.image_viewer_open),
                    onClick = onOpen,
                    onLongClickLabel = if (onLongPress != null) stringResource(R.string.message_actions_cd) else null,
                    onLongClick = onLongPress,
                ),
        )
        AttachmentImage.Loading -> Box(
            Modifier
                .size(THUMB)
                .clip(shape)
                .border(Dimens.line, colors.line, shape)
                .background(colors.panel2),
            contentAlignment = Alignment.Center,
        ) {
            Lucide(
                R.drawable.lucide_image,
                contentDescription = stringResource(R.string.attachment_image_cd, ref.name),
                tint = colors.inkDim,
                modifier = Modifier.size(16.dp),
            )
        }
        AttachmentImage.Unavailable -> FilePill(ref)
    }
}

@Composable
private fun FilePill(ref: AttachedRef) {
    val colors = RivetTheme.colors
    val shape = RoundedCornerShape(Radius.full)
    val cd = stringResource(if (ref.isImage) R.string.attachment_image_cd else R.string.attachment_file_cd, ref.name)
    Row(
        Modifier
            .widthIn(max = 240.dp)
            .heightIn(min = 28.dp)
            .clip(shape)
            .border(Dimens.line, colors.line, shape)
            .background(colors.panel)
            .padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Lucide(
            if (ref.isImage) R.drawable.lucide_image else R.drawable.lucide_file,
            contentDescription = cd,
            tint = colors.inkDim,
            modifier = Modifier.size(14.dp),
        )
        Text(
            ref.name,
            color = colors.ink,
            style = RivetType.mono11,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Full-screen view of an attached image: fit to the screen on the page
 * background; tap anywhere or ✕ closes it.
 */
@Composable
fun ImageViewerSheet(ref: AttachedRef, images: AttachmentImageSource, onDismiss: () -> Unit) {
    val colors = RivetTheme.colors
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .background(colors.bg)
                .clickable(
                    role = Role.Button,
                    onClickLabel = stringResource(R.string.image_viewer_close),
                    onClick = onDismiss,
                ),
        ) {
            val px = with(LocalDensity.current) { maxOf(maxWidth, maxHeight).roundToPx() }
            when (val img = rememberAttachmentImage(ref.uri, px.coerceAtMost(2048), images)) {
                is AttachmentImage.Ready -> Image(
                    bitmap = img.bitmap,
                    contentDescription = stringResource(R.string.attachment_image_cd, ref.name),
                    contentScale = ContentScale.Fit,
                    modifier = Modifier.fillMaxSize().padding(16.dp),
                )
                else -> Box(Modifier.align(Alignment.Center)) { FilePill(ref) }
            }
            Text(
                ref.name,
                color = colors.inkDim,
                style = RivetType.mono11,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .navigationBarsPadding()
                    .padding(16.dp),
            )
            Box(
                Modifier
                    .align(Alignment.TopEnd)
                    .statusBarsPadding()
                    .padding(8.dp)
                    .size(Dimens.touchTarget)
                    .clip(RoundedCornerShape(Radius.full))
                    .clickable(role = Role.Button, onClick = onDismiss),
                contentAlignment = Alignment.Center,
            ) {
                Lucide(
                    R.drawable.lucide_x,
                    contentDescription = stringResource(R.string.image_viewer_close),
                    tint = colors.ink,
                    modifier = Modifier.size(20.dp),
                )
            }
        }
    }
}
