// pg-adapter.js — Адаптер PostgreSQL под интерфейс mysql2/promise
// Позволяет использовать весь код с mysql2 без изменений:
//   - ? плейсхолдеры → $1, $2, ...
//   - ON DUPLICATE KEY UPDATE → INSERT ... ON CONFLICT DO UPDATE
//   - backtick идентификаторы → double-quote
//   - db.query() возвращает [rows, fields] как mysql2

const { Pool } = require("pg");

// ── SQL-трансформации ────────────────────────────────────────────

function convertPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function convertBackticks(sql) {
  return sql.replace(/`([^`]+)`/g, '"$1"');
}

// ON DUPLICATE KEY UPDATE col=val, col2=val2
// → ON CONFLICT (...) DO UPDATE SET col=EXCLUDED.col, ...
function convertOnDuplicate(sql) {
  // Pattern: INSERT INTO "table" (cols) VALUES (...) ON DUPLICATE KEY UPDATE assignments
  return sql.replace(
    /INSERT INTO\s+("?\w+"?)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)\s*ON DUPLICATE KEY UPDATE\s+(.+?)(?:;|$)/gis,
    (match, table, colsPart, valsPart, updatesPart) => {
      const cols = colsPart.split(",").map(c => c.trim());

      // Parse update assignments: col=val, col2=col2+1, etc.
      // We'll convert them to SET col=EXCLUDED.col style or keep expressions
      const updates = parseUpdates(updatesPart, cols);

      // Determine conflict columns from PRIMARY KEY / UNIQUE
      // We can't know at runtime easily, so we use ON CONFLICT(col1,col2...)
      // Heuristic: use the first col if single, or try to detect from context
      // Better approach: use ON CONFLICT DO UPDATE with the update clause as-is
      // but replace references to VALUES(col) with EXCLUDED.col
      const conflictCols = detectConflictCols(table, cols, updates);

      const setParts = updates.map(u => {
        // Convert VALUES(col) → EXCLUDED.col
        let expr = u.expr.replace(/VALUES\s*\(\s*"?(\w+)"?\s*\)/gi, 'EXCLUDED."$1"');
        return `"${u.col}" = ${expr}`;
      });

      const colsFormatted = cols.map(c => c.replace(/`/g, "").replace(/"/g, "")).map(c => `"${c}"`).join(", ");
      const valsFormatted = valsPart;

      return `INSERT INTO ${table} (${colsFormatted}) VALUES (${valsFormatted}) ON CONFLICT (${conflictCols}) DO UPDATE SET ${setParts.join(", ")}`;
    }
  );
}

function parseUpdates(updateStr) {
  // Split by comma but not inside functions/parens
  const results = [];
  let depth = 0, current = "", col = null;

  for (let i = 0; i < updateStr.length; i++) {
    const c = updateStr[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;

    if (c === "=" && depth === 0 && col === null) {
      col = current.trim().replace(/`|"/g, "");
      current = "";
    } else if (c === "," && depth === 0) {
      if (col) results.push({ col, expr: current.trim() });
      col = null;
      current = "";
    } else {
      current += c;
    }
  }
  if (col) results.push({ col, expr: current.trim() });
  return results;
}

function detectConflictCols(table, insertCols, updates) {
  // Known conflict columns by table name
  const CONFLICT_MAP = {
    guild_settings:  '"guild_id", "key"',
    warnings:        '"guild_id", "user"',
    eco_users:       '"guild_id", "user_id"',
    mod_stats:       '"guild_id", "mod_id"',
    ai_blocks:       '"guild_id", "user_id"',
    aurex_weights:   '"guild_id", "key"',
    channel_protect: '"guild_id", "channel_id"',
    mutes:           '"guild_id", "user_id"',
    ai_daily_chat:   '"guild_id", "user_id"',
    eco_shop:        '"id"',
    tickets:         '"ticket_id"',
    ticket_tags:     '"id"',
    server_rules:    '"id"',
    ticket_categories: '"id"',
  };

  const cleanTable = table.replace(/"/g, "");
  return CONFLICT_MAP[cleanTable] || `"${insertCols[0].replace(/`|"/g, "")}"`;
}

// "key" reserved word — add quotes
function fixReservedWords(sql) {
  // Already handled by backtick→doublequote converter
  return sql;
}

// COUNT(*)+1 → not valid in PG, wrap in subquery — handle in query results instead
// Actually PostgreSQL supports COUNT(*)+1... let's check the specific case
// SELECT COUNT(*)+1 as rank → works in PG, no change needed

function transformSQL(sql) {
  let s = sql;
  s = convertBackticks(s);
  s = convertOnDuplicate(s);
  s = convertPlaceholders(s);
  return s.trim();
}

// ── POOL WRAPPER ─────────────────────────────────────────────────

class PgPool {
  constructor(config) {
    this.pool = new Pool({
      host:     config.host,
      port:     config.port || 5432,
      user:     config.user,
      password: config.password,
      database: config.database,
      max:      config.connectionLimit || 20,
      ssl:      config.ssl || false,
    });

    this.pool.on("error", (err) => {
      console.error("[pg-adapter] Pool error:", err.message);
    });
  }

  async query(sql, params = []) {
    const transformed = transformSQL(sql);

    if (process.env.PG_DEBUG) {
      console.log("[pg-adapter] SQL:", transformed);
      console.log("[pg-adapter] params:", params);
    }

    try {
      const result = await this.pool.query(transformed, params);
      // mysql2 returns [rows, fields] — mimic that
      return [result.rows, result.fields];
    } catch (err) {
      console.error("[pg-adapter] Query error:", err.message);
      console.error("[pg-adapter] SQL was:", transformed);
      console.error("[pg-adapter] Params:", params);
      throw err;
    }
  }

  async getConnection() {
    const client = await this.pool.connect();
    return {
      query: async (sql, params = []) => {
        const transformed = transformSQL(sql);
        const result = await client.query(transformed, params);
        return [result.rows, result.fields];
      },
      release: () => client.release(),
      end: () => client.release(),
    };
  }

  async end() {
    await this.pool.end();
  }
}

function createPool(config) {
  return new PgPool(config);
}

module.exports = { createPool };
