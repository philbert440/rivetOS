package io.rivethub.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.rivethub.app.R
import io.rivethub.app.ui.theme.RivetTheme
import io.rivethub.app.ui.theme.RivetType

/**
 * Protocol-owned Codex Model / Effort row above the composer.
 * Twin of rivethub-web `chat.tsx` nativeModels row.
 */
@Composable
fun NativeTurnControls(
    models: List<SelectOption>,
    model: String,
    onModel: (String) -> Unit,
    efforts: List<SelectOption>,
    effort: String,
    onEffort: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    if (models.isEmpty()) return
    val colors = RivetTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
            .padding(top = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(stringResource(R.string.harness_native_model), color = colors.inkDim, style = RivetType.xs)
        RivetSelect(
            value = model,
            options = models,
            onChange = onModel,
            title = stringResource(R.string.harness_native_model),
            enabled = enabled,
            modifier = Modifier.weight(1f),
        )
        if (efforts.isNotEmpty()) {
            Text(stringResource(R.string.harness_native_effort), color = colors.inkDim, style = RivetType.xs)
            RivetSelect(
                value = effort,
                options = efforts,
                onChange = onEffort,
                title = stringResource(R.string.harness_native_effort),
                enabled = enabled,
                modifier = Modifier.weight(1f),
            )
        }
    }
}
