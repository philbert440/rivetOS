package dev.rivet.app.ui.components.message

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import kotlinx.datetime.toJavaLocalDateTime
import dev.rivet.ai.core.MessageRole
import dev.rivet.ai.provider.Model
import dev.rivet.ai.ui.UIMessage
import dev.rivet.ai.ui.isEmptyUIMessage
import dev.rivet.app.R
import dev.rivet.app.data.model.Assistant
import dev.rivet.app.data.model.Avatar
import dev.rivet.app.ui.components.ui.AutoAIIcon
import dev.rivet.app.ui.components.ui.UIAvatar
import dev.rivet.app.ui.context.LocalSettings
import dev.rivet.app.utils.toMessageTimeString

@Composable
fun ChatMessageUserAvatar(
    message: UIMessage,
    avatar: Avatar,
    nickname: String,
    modifier: Modifier = Modifier,
) {
    val settings = LocalSettings.current
    if (message.role == MessageRole.USER && !message.parts.isEmptyUIMessage() && settings.displaySetting.showUserAvatar) {
        Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (settings.displaySetting.showDateTimeInMessage) {
                    Text(
                        text = message.createdAt.toJavaLocalDateTime().toMessageTimeString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = LocalContentColor.current.copy(alpha = 0.5f),
                        maxLines = 1,
                    )
                }
                Text(
                    text = nickname.ifEmpty { stringResource(R.string.user_default_name) },
                    style = MaterialTheme.typography.labelMediumEmphasized,
                    maxLines = 1,
                )
            }
            UIAvatar(
                name = nickname,
                modifier = Modifier.size(24.dp),
                value = avatar,
                loading = false,
            )
        }
    }
}

/**
 * Per-agent accent for the author label: the two resident agents get distinct theme hues
 * so a mixed-agent conversation reads at a glance (cross-agent attribution is already in
 * the data — each assistant message carries the model that produced it).
 */
@Composable
private fun agentAccent(modelId: String?): Color? = when (modelId) {
    "rivet-claude" -> MaterialTheme.colorScheme.primary
    "rivet-grok" -> MaterialTheme.colorScheme.tertiary
    else -> null
}

@Composable
fun ChatMessageAssistantAvatar(
    message: UIMessage,
    loading: Boolean,
    model: Model?,
    assistant: Assistant?,
    modifier: Modifier = Modifier,
) {
    val settings = LocalSettings.current
    val showIcon = settings.displaySetting.showModelIcon
    val useAssistantAvatar = assistant?.useAssistantAvatar == true
    if (message.role == MessageRole.ASSISTANT && (model != null || useAssistantAvatar)) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
            modifier = modifier
        ) {
            if (useAssistantAvatar) {
                if (showIcon) {
                    UIAvatar(
                        name = assistant.name,
                        modifier = Modifier.size(24.dp),
                        value = assistant.avatar,
                        loading = loading,
                    )
                }
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (settings.displaySetting.showModelName) {
                        Text(
                            text = assistant.name.ifEmpty { stringResource(R.string.assistant_page_default_assistant) },
                            style = MaterialTheme.typography.labelMediumEmphasized,
                            color = agentAccent(model?.modelId) ?: LocalContentColor.current,
                            maxLines = 1,
                        )
                    }
                    if (settings.displaySetting.showDateTimeInMessage) {
                        Text(
                            text = message.createdAt.toJavaLocalDateTime().toMessageTimeString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalContentColor.current.copy(alpha = 0.5f),
                            maxLines = 1,
                        )
                    }
                }
            } else if (model != null) {
                if (showIcon) {
                    AutoAIIcon(
                        name = model.modelId,
                        modifier = Modifier.size(24.dp),
                        loading = loading
                    )
                }
                Row(
                    modifier = Modifier.weight(1f),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (settings.displaySetting.showModelName) {
                        Text(
                            text = model.displayName,
                            style = MaterialTheme.typography.labelMediumEmphasized,
                            color = agentAccent(model.modelId) ?: LocalContentColor.current,
                            maxLines = 1,
                        )
                    }
                    if (settings.displaySetting.showDateTimeInMessage) {
                        Text(
                            text = message.createdAt.toJavaLocalDateTime().toMessageTimeString(),
                            style = MaterialTheme.typography.labelSmall,
                            color = LocalContentColor.current.copy(alpha = 0.5f),
                            maxLines = 1,
                        )
                    }
                }
            }
        }
    }
}
