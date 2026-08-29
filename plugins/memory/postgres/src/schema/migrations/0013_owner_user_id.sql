-- Per-user tenancy: persist the owning user on conversations and messages.
-- Written at insert from UserContext; listing/search filters use it.
ALTER TABLE ros_conversations ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
ALTER TABLE ros_messages ADD COLUMN IF NOT EXISTS owner_user_id TEXT;
CREATE INDEX IF NOT EXISTS ros_conversations_owner_user_id_idx ON ros_conversations (owner_user_id);
CREATE INDEX IF NOT EXISTS ros_messages_owner_user_id_idx ON ros_messages (owner_user_id);
