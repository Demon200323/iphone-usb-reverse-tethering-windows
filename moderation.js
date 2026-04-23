// modules/moderation.js — AUREX-9 v3.0

const { EmbedBuilder, PermissionFlagsBits, AuditLogEvent } = require("discord.js");
const { getGuildSetting } = require("./settings");

class ModerationManager {
  constructor(client, db, auditLogger) {
    this.client      = client;
    this.db          = db;
    this.auditLogger = auditLogger;
  }

  // ── Запись действия модератора ────────────────────────────────
  async logAction(guildId, modId, targetId, action, reason, duration = null) {
    await this.db.query(
      "INSERT INTO mod_actions (guild_id,mod_id,target_id,action,reason,duration,created_at) VALUES (?,?,?,?,?,?,?)",
      [guildId, modId, targetId, action, reason, duration, Date.now()]
    ).catch(() => {});
    // Обновить статистику модератора
    const col = { warn:"warns_issued", mute:"mutes_issued", ban:"bans_issued", delete:"messages_deleted" }[action];
    if (col) {
      await this.db.query(
        `INSERT INTO mod_stats (guild_id,mod_id,${col},last_active) VALUES (?,?,1,?) ON DUPLICATE KEY UPDATE ${col}=${col}+1, last_active=?`,
        [guildId, modId, Date.now(), Date.now()]
      ).catch(() => {});
    }
  }

  // ── ПРЕДУПРЕЖДЕНИЕ ────────────────────────────────────────────
  async warn(member, reason, author, guildId) {
    try {
      const protectedRoles = JSON.parse(await getGuildSetting(this.db, guildId, "protected_roles", "[]"));
      const immuneRoles    = JSON.parse(await getGuildSetting(this.db, guildId, "immune_roles", "[]"));
      if (protectedRoles.some(r => member.roles.cache.has(r))) return;
      if (immuneRoles.some(r => member.roles.cache.has(r))) return;

      const [rows] = await this.db.query("SELECT count FROM warnings WHERE user=? AND guild_id=?", [member.id, guildId]);
      const count  = rows.length ? rows[0].count + 1 : 1;
      await this.db.query(
        "INSERT INTO warnings (guild_id,user,count) VALUES (?,?,?) ON DUPLICATE KEY UPDATE count=?",
        [guildId, member.id, count, count]
      );

      if (author) await this.logAction(guildId, author.id, member.id, "warn", reason);

      await member.send({ embeds: [new EmbedBuilder()
        .setTitle("⚠️ Предупреждение")
        .setColor(0xff9900)
        .setDescription(`Вы получили предупреждение на сервере **${member.guild.name}**`)
        .addFields(
          { name: "Причина", value: reason },
          { name: "Предупреждений", value: `${count}/3` },
          { name: "Выдал", value: author ? `<@${author.id}>` : "Система" }
        ).setFooter({ text: "AUREX-9" }).setTimestamp()
      ]}).catch(() => {});

      await this.auditLogger.guildLog(guildId, "⚠️ Предупреждение", [
        { name: "Пользователь", value: `<@${member.id}>` },
        { name: "Причина", value: reason },
        { name: "Предупреждений", value: `${count}/3` },
        { name: "Выдал", value: author ? `<@${author.id}>` : "Система" }
      ], 0xff9900);

      const maxWarns = parseInt(await getGuildSetting(this.db, guildId, "max_warnings", 3));
      const muteTime = parseInt(await getGuildSetting(this.db, guildId, "mute_duration_ms", 600000));
      if (count >= maxWarns) {
        await member.timeout(muteTime, `Автомут: ${maxWarns} предупреждения`).catch(() => {});
        await this.db.query("DELETE FROM warnings WHERE user=? AND guild_id=?", [member.id, guildId]);
        await this.auditLogger.guildLog(guildId, "🔇 Автомут", [
          { name: "Пользователь", value: `<@${member.id}>` },
          { name: "Длительность", value: `${Math.round(muteTime/60000)} мин.` }
        ], 0xff0000);
      }
      return count;
    } catch (e) { console.error("[warn]", e.message); }
  }

  // ── АВТО-НАРУШЕНИЕ ────────────────────────────────────────────
  async handleViolation(member, message, result, guildId) {
    try {
      const reasons = [];
      if (result.mat)           reasons.push("нецензурная лексика");
      if (result.spam)          reasons.push("спам");
      if (result.porn)          reasons.push("NSFW-контент");
      if (result.caps)          reasons.push("злоупотребление капсом");
      if (result.invite)        reasons.push("реклама/инвайт");
      if (result.suspiciousLink)reasons.push("подозрительная ссылка");

      const reason = "Авто-модерация: " + reasons.join(", ");
      if (result.mat || result.porn || result.spam || result.invite || result.suspiciousLink) {
        await message.delete().catch(() => {});
      }
      await this.warn(member, reason, null, guildId);
    } catch (e) { console.error("[handleViolation]", e.message); }
  }

  // ── СНЯТИЕ МОДЕРАТОРА (за удаление каналов / массовый бан) ────
  async punishMod(member, reason, guildId) {
    try {
      const botMember  = await member.guild.members.fetch(this.client.user.id);
      const botHighest = botMember.roles.highest.position;

      const modRoles = JSON.parse(await getGuildSetting(this.db, guildId, "mod_roles", "[]"));
      for (const roleId of modRoles) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role || role.position >= botHighest) continue;
        await member.roles.remove(roleId).catch(() => {});
      }
      const adminRoles = JSON.parse(await getGuildSetting(this.db, guildId, "admin_roles", "[]"));
      for (const roleId of adminRoles) {
        const role = member.guild.roles.cache.get(roleId);
        if (!role || role.position >= botHighest) continue;
        await member.roles.remove(roleId).catch(() => {});
      }

      const cadetRoleId = await getGuildSetting(this.db, guildId, "cadet_role");
      if (cadetRoleId) {
        const cr = member.guild.roles.cache.get(cadetRoleId);
        if (cr && cr.position < botHighest) await member.roles.add(cadetRoleId).catch(() => {});
      }

      const muteTime = parseInt(await getGuildSetting(this.db, guildId, "mute_duration_ms", 600000));
      if (botMember.permissions.has(PermissionFlagsBits.ModerateMembers) &&
          botMember.roles.highest.position > member.roles.highest.position) {
        await member.timeout(muteTime * 6, reason).catch(() => {}); // 1 час при анти-краше
      }

      await member.send({ embeds: [new EmbedBuilder()
        .setTitle("🚨 Вы сняты с должности")
        .setColor(0xff0000)
        .setDescription("Ваши модераторские роли сняты за нарушение правил.")
        .addFields({ name: "Причина", value: reason }, { name: "Сервер", value: member.guild.name })
        .setTimestamp()
      ]}).catch(() => {});

      await this.auditLogger.guildLog(guildId, "🚨 МОДЕРАТОР СНЯТ", [
        { name: "Пользователь", value: `<@${member.id}>` },
        { name: "Причина", value: reason }
      ], 0xff0000);

      await this.logAction(guildId, "system", member.id, "punish_mod", reason);
    } catch (e) { console.error("[punishMod]", e.message); }
  }
}

module.exports = { ModerationManager };
