package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import io.rivethub.app.ui.theme.Dimens
import io.rivethub.app.ui.theme.OnEm
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = Dimens.primaryButton),
        shape = RoundedCornerShape(Dimens.radius6),
        colors = ButtonDefaults.buttonColors(
            containerColor = RivetTheme.colors.em,
            contentColor = OnEm,
        ),
    ) {
        Text(text, style = RivetType.title, color = OnEm)
    }
}
