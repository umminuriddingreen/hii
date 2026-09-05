-- SPDX-License-Identifier: LicenseRef-BSL-1.1
CREATE TABLE chat_conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    active_leaf_id TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (active_leaf_id, id) REFERENCES chat_messages(id, conversation_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    parent_id TEXT,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
    created_at INTEGER NOT NULL,
    UNIQUE(id, conversation_id),
    FOREIGN KEY (parent_id, conversation_id) REFERENCES chat_messages(id, conversation_id)
);
CREATE INDEX chat_messages_conversation ON chat_messages(conversation_id, created_at);
CREATE INDEX chat_messages_parent ON chat_messages(parent_id);
CREATE TABLE chat_message_parts (
    message_id TEXT NOT NULL REFERENCES chat_messages(id),
    position INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('text','reasoning')),
    content TEXT NOT NULL,
    PRIMARY KEY(message_id, position)
);
CREATE TABLE chat_generations (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),
    message_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('streaming','completed','cancelled','failed','interrupted')),
    model TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    max_tokens INTEGER NOT NULL,
    error TEXT,
    finish_reason TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    FOREIGN KEY(message_id, conversation_id) REFERENCES chat_messages(id, conversation_id)
);
CREATE UNIQUE INDEX chat_one_active_generation ON chat_generations(conversation_id) WHERE status = 'streaming';
CREATE TABLE chat_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
