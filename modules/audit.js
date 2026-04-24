// modules/audit.js — AUREX-9 v3.0
const { EmbedBuilder } = require("discord.js");
const { getGuildSetting } = require("./settings");

class AuditLogger {
  constructor(client, db) {
    this.client = client;
    this.db     = db;
  }

  async guildLog(guildId, title, fields = [], color = 0x3399ff) {
    try {
      if (!guildId) return;
      const enabled = await getGuildSetting(this.db, guildId, "audit_enabled", true);
      if (!enabled) return;
      const channelId = await getGuildSetting(this.db, guildId, "log_channel");
      if (!channelId) return;
      const ch = await this.client.channels.fetch(channelId).catch(() => null);
      if (!ch?.isTextBased()) return;
      const embed = new EmbedBuilder()
        .setTitle(title).setColor(color).setTimestamp()
        .setFooter({ text: "AUREX-9 Audit" });
      if (fields.length) embed.addFields(fields.map(f => ({ name: f.name, value: String(f.value || "—").slice(0,1024), inline: f.inline ?? true })));
      await ch.send({ embeds: [embed] }).catch(() => {});
    } catch {}
  }

  async globalLog(title, fields = []) {
    try {
      for (const guild of this.client.guilds.cache.values()) {
        await this.guildLog(guild.id, title, fields, 0x9900ff);
      }
    } catch {}
  }
}

module.exports = { AuditLogger };
