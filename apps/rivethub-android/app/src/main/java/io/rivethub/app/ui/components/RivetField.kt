package io.rivethub.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import io.rivethub.app.ui.theme.Radius
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

enum class RivetFieldSize { Settings, Filter, Rename }

/** Desktop settings/filter/rename inputs — BasicTextField, never OutlinedTextField. */
@Composable
fun RivetField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    password: Boolean = false,
    singleLine: Boolean = true,
    size: RivetFieldSize = RivetFieldSize.Settings,
) {
    val colors = RivetTheme.colors
    var focused by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(Radius.sm)
    val style: TextStyle
    val padH: Int
    val padV: Int
    val placeholderAlpha: Float
    when (size) {
        RivetFieldSize.Settings -> {
            style = RivetType.mono14
            padH = 12
            padV = 8
            placeholderAlpha = 1f
        }
        RivetFieldSize.Filter -> {
            style = RivetType.xs
            padH = 8
            padV = 4
            placeholderAlpha = 0.6f
        }
        RivetFieldSize.Rename -> {
            style = RivetType.xs
            padH = 12
            padV = 6
            placeholderAlpha = 1f
        }
    }
    val bg = if (size == RivetFieldSize.Rename) colors.panel2 else colors.panel
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        textStyle = style.copy(color = colors.ink),
        cursorBrush = SolidColor(colors.em),
        keyboardOptions = keyboard,
        visualTransformation = if (password) {
            androidx.compose.ui.text.input.PasswordVisualTransformation()
        } else {
            VisualTransformation.None
        },
        modifier = modifier
            .fillMaxWidth()
            .onFocusChanged { focused = it.isFocused }
            .border(1.dp, if (focused) colors.em else colors.line, shape)
            .background(bg, shape)
            .padding(horizontal = padH.dp, vertical = padV.dp),
        decorationBox = { inner ->
            Box {
                if (value.isEmpty()) {
                    Text(
                        placeholder,
                        color = colors.inkDim.copy(alpha = placeholderAlpha),
                        style = style,
                    )
                }
                inner()
            }
        },
    )
}
