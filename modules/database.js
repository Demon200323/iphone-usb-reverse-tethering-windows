// modules/database.js — AUREX-9 v3.0 | PostgreSQL

async function initDB(db) {
  const queries = [
    `CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id VARCHAR(32) NOT NULL,
      "key" VARCHAR(128) NOT NULL,
      value TEXT,
      PRIMARY KEY (guild_id, "key")
    )`,
    `CREATE TABLE IF NOT EXISTS warnings (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      "user" VARCHAR(32) NOT NULL,
      count INT DEFAULT 0,
      UNIQUE (guild_id, "user")
    )`,
    `CREATE TABLE IF NOT EXISTS tickets (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(64) NOT NULL UNIQUE,
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(64),
      user_id VARCHAR(64),
      mod_id VARCHAR(64),
      status VARCHAR(32) DEFAULT 'open',
      category VARCHAR(64),
      sub_category VARCHAR(64),
      priority VARCHAR(32) DEFAULT 'normal',
      subject TEXT,
      reason TEXT,
      closed_reason TEXT,
      closed_by VARCHAR(64),
      closed_at BIGINT,
      claimed_by VARCHAR(64),
      rating INT,
      created_at BIGINT,
      updated_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS tickets__idx_guild    ON tickets (guild_id)`,
    `CREATE INDEX IF NOT EXISTS tickets__idx_channel  ON tickets (channel_id)`,
    `CREATE INDEX IF NOT EXISTS tickets__idx_status   ON tickets (status)`,
    `CREATE TABLE IF NOT EXISTS ticket_messages (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(64) NOT NULL,
      author_id VARCHAR(64),
      content TEXT,
      created_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS ticket_messages__idx_ticket ON ticket_messages (ticket_id)`,
    `CREATE TABLE IF NOT EXISTS mod_stats (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      mod_id VARCHAR(64) NOT NULL,
      tickets_handled INT DEFAULT 0,
      warns_issued INT DEFAULT 0,
      mutes_issued INT DEFAULT 0,
      bans_issued INT DEFAULT 0,
      messages_deleted INT DEFAULT 0,
      avg_response_ms BIGINT DEFAULT 0,
      sla_violations INT DEFAULT 0,
      quality_score INT DEFAULT 0,
      last_active BIGINT,
      UNIQUE (guild_id, mod_id)
    )`,
    `CREATE TABLE IF NOT EXISTS bans_log (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32),
      moderator VARCHAR(64),
      "user" VARCHAR(64),
      created_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS bans_log__idx_guild_mod ON bans_log (guild_id, moderator)`,
    `CREATE TABLE IF NOT EXISTS channel_delete_log (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32),
      executor VARCHAR(64),
      channel_name VARCHAR(256),
      created_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS channel_delete_log__idx_guild_exec ON channel_delete_log (guild_id, executor)`,
    `CREATE TABLE IF NOT EXISTS aurex_training (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32),
      message TEXT,
      result_mat SMALLINT DEFAULT 0,
      result_caps SMALLINT DEFAULT 0,
      result_spam SMALLINT DEFAULT 0,
      result_porn SMALLINT DEFAULT 0,
      mod_decision SMALLINT DEFAULT 0,
      moderator VARCHAR(64),
      created_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS aurex_weights (
      guild_id VARCHAR(32) NOT NULL,
      "key" VARCHAR(64) NOT NULL,
      value FLOAT DEFAULT 1.0,
      PRIMARY KEY (guild_id, "key")
    )`,
    `CREATE TABLE IF NOT EXISTS ai_blocks (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      unblock_at BIGINT NOT NULL,
      reason TEXT,
      PRIMARY KEY (guild_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ai_daily_chat (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      ts BIGINT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ai_daily_chat__idx_user ON ai_daily_chat (guild_id, user_id)`,
    `CREATE TABLE IF NOT EXISTS eco_users (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      coins INT DEFAULT 0,
      xp INT DEFAULT 0,
      level INT DEFAULT 1,
      messages INT DEFAULT 0,
      voice_mins INT DEFAULT 0,
      last_daily BIGINT DEFAULT 0,
      last_work BIGINT DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS eco_shop (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      name VARCHAR(128) NOT NULL,
      description TEXT,
      price INT DEFAULT 100,
      role_id VARCHAR(64),
      sort_order INT DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS eco_shop__idx_guild ON eco_shop (guild_id)`,
    `CREATE TABLE IF NOT EXISTS ticket_categories (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      name VARCHAR(64) NOT NULL,
      emoji VARCHAR(8) DEFAULT '🎫',
      description TEXT,
      role_id VARCHAR(64),
      priority VARCHAR(32) DEFAULT 'normal',
      sort_order INT DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS ticket_categories__idx_guild ON ticket_categories (guild_id)`,
    `CREATE TABLE IF NOT EXISTS mutes (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      unmute_at BIGINT NOT NULL,
      reason TEXT,
      moderator VARCHAR(128),
      PRIMARY KEY (guild_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS mod_actions (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      mod_id VARCHAR(64),
      target_id VARCHAR(64),
      action VARCHAR(32),
      reason TEXT,
      duration BIGINT,
      created_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS mod_actions__idx_guild  ON mod_actions (guild_id)`,
    `CREATE INDEX IF NOT EXISTS mod_actions__idx_mod    ON mod_actions (guild_id, mod_id)`,
    `CREATE INDEX IF NOT EXISTS mod_actions__idx_target ON mod_actions (guild_id, target_id)`,
    `CREATE TABLE IF NOT EXISTS server_rules (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      type VARCHAR(32) DEFAULT 'server',
      title VARCHAR(256),
      content TEXT,
      sort_order INT DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS server_rules__idx_guild ON server_rules (guild_id, type)`,
    `CREATE TABLE IF NOT EXISTS ticket_activity (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32),
      mod_id VARCHAR(64),
      ticket_id VARCHAR(64),
      response_time BIGINT,
      created_at BIGINT
    )`,
    `CREATE TABLE IF NOT EXISTS ticket_history (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(64) NOT NULL,
      guild_id VARCHAR(32),
      action VARCHAR(64),
      author_id VARCHAR(64),
      reason TEXT,
      created_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS ticket_history__idx_ticket ON ticket_history (ticket_id)`,
    `CREATE TABLE IF NOT EXISTS ticket_tags (
      id SERIAL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL,
      tag VARCHAR(64)
    )`,
    `CREATE INDEX IF NOT EXISTS ticket_tags__idx_guild ON ticket_tags (guild_id)`,
    `CREATE TABLE IF NOT EXISTS channel_protect (
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(64) NOT NULL,
      name TEXT,
      parent_id VARCHAR(64),
      position INT,
      PRIMARY KEY (guild_id, channel_id)
    )`,
  ];

  for (const q of queries) {
    await db.query(q).catch(err => {
      console.warn("[initDB] Warning:", err.message.slice(0, 120));
    });
  }

  console.log("✅ AUREX-9 v3.0 — таблицы инициализированы (PostgreSQL)");
}

module.exports = { initDB };
