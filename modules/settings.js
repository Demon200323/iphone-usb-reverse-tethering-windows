// modules/settings.js — AUREX-9 v3.0 | PostgreSQL

async function getGuildSetting(db, guildId, key, defaultValue = null) {
  const [rows] = await db.query(
    'SELECT value FROM guild_settings WHERE guild_id=$1 AND "key"=$2',
    [guildId, key]
  );
  if (!rows.length) return defaultValue;
  const v = rows[0].value;
  if (v === "true")  return true;
  if (v === "false") return false;
  if (v === "null")  return null;
  return v;
}

async function setGuildSetting(db, guildId, key, value) {
  const val = typeof value === "object" ? JSON.stringify(value) : String(value);
  await db.query(
    'INSERT INTO guild_settings (guild_id, "key", value) VALUES ($1,$2,$3) ON CONFLICT (guild_id, "key") DO UPDATE SET value=$3',
    [guildId, key, val]
  );
}

async function getAllGuildSettings(db, guildId) {
  const [rows] = await db.query(
    'SELECT "key", value FROM guild_settings WHERE guild_id=$1',
    [guildId]
  );
  const result = {};
  for (const r of rows) {
    if (r.value === "true")       result[r.key] = true;
    else if (r.value === "false") result[r.key] = false;
    else result[r.key] = r.value;
  }
  return result;
}

module.exports = { getGuildSetting, setGuildSetting, getAllGuildSettings };
