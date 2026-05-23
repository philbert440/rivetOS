"""SQL constants for the RivetOS ros_* tables.

Schema reference: ``/rivet-shared/baseline-schema-ct110.sql``. Generated columns
(``content_tsv``), embedding columns (``embedding``, ``embed_*``), and access
counters (``access_count``, ``last_accessed_at``) are maintained by RivetOS
background workers — we never write them from the plugin.

``ros_messages_role_check`` enforces role ∈ {system, user, assistant, tool}.
"""

from __future__ import annotations

# Roles accepted by the ros_messages_role_check constraint.
ROLE_SYSTEM = "system"
ROLE_USER = "user"
ROLE_ASSISTANT = "assistant"
ROLE_TOOL = "tool"

VALID_ROLES = {ROLE_SYSTEM, ROLE_USER, ROLE_ASSISTANT, ROLE_TOOL}


# ---------------------------------------------------------------------------
# Conversation lifecycle
# ---------------------------------------------------------------------------

SQL_FIND_ACTIVE_CONVERSATION = """
SELECT id
  FROM ros_conversations
 WHERE session_key = %s
   AND agent       = %s
   AND active      = true
 ORDER BY updated_at DESC
 LIMIT 1
"""

SQL_INSERT_CONVERSATION = """
INSERT INTO ros_conversations (session_key, agent, channel, title, created_at, updated_at)
VALUES (%s, %s, %s, %s, NOW(), NOW())
RETURNING id
"""

SQL_TOUCH_CONVERSATION = """
UPDATE ros_conversations
   SET updated_at = NOW()
 WHERE id = %s
"""

SQL_CLOSE_CONVERSATION = """
UPDATE ros_conversations
   SET active     = false,
       updated_at = NOW()
 WHERE id = %s
"""

SQL_CLOSE_BY_SESSION_KEY = """
UPDATE ros_conversations
   SET active     = false,
       updated_at = NOW()
 WHERE session_key = %s
   AND agent       = %s
   AND active      = true
"""


# ---------------------------------------------------------------------------
# Message insert
# ---------------------------------------------------------------------------

SQL_INSERT_MESSAGE = """
INSERT INTO ros_messages
       (conversation_id, agent, channel, role, content,
        tool_name, tool_args, tool_result, metadata, created_at)
VALUES (%s, %s, %s, %s, %s,
        %s, %s::jsonb, %s, %s::jsonb, COALESCE(%s, NOW()))
RETURNING id
"""
