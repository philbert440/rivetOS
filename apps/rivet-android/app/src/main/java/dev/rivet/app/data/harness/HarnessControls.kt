package dev.rivet.app.data.harness

import org.json.JSONObject

data class HarnessModelChoice(
    val id: String,
    val label: String,
    val efforts: List<String>,
    val defaultEffort: String?,
    val isDefault: Boolean,
) {
    companion object {
        fun from(json: JSONObject): HarnessModelChoice = HarnessModelChoice(
            id = json.optString("id"), label = json.optString("label"),
            efforts = json.optJSONArray("efforts").objects().map { it.optString("id") },
            defaultEffort = json.optJSONArray("efforts").objects().firstOrNull { it.optBoolean("default") }?.optString("id"),
            isDefault = json.optBoolean("default"),
        )
    }
}

data class HarnessQuestion(val question: String, val options: List<String>)
data class HarnessQuestionAnswer(val question: Int, val labels: List<String>, val other: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("question", question)
        .put("labels", org.json.JSONArray(labels)).apply { other?.let { put("other", it) } }
}

data class HarnessControlsState(
    val models: List<HarnessModelChoice> = emptyList(),
    val model: String? = null,
    val effort: String? = null,
    val imageAttachments: Boolean = false,
    val prompts: List<HarnessEvent.Prompt> = emptyList(),
    val approvals: List<HarnessEvent.ApprovalRequest> = emptyList(),
    val error: String? = null,
    val submitting: Boolean = false,
)
