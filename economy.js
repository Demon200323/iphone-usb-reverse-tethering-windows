// modules/economy.js — AUREX-9 v3.0 | Экономика (MEE6-style + расширения)
const { EmbedBuilder, AttachmentBuilder } = require("discord.js");

const XP_COOLDOWN = 5000; // мс между начислением XP
const xpCooldowns = new Map();

function xpForLevel(level) { return level * 100 + 100; }

class EconomyManager {
  constructor(client, db) {
    this.client = client;
    this.db     = db;
  }

  async getUser(guildId, userId) {
    const [rows] = await this.db.query("SELECT * FROM eco_users WHERE guild_id=? AND user_id=?", [guildId, userId]);
    if (rows.length) return rows[0];
    await this.db.query("INSERT INTO eco_users (guild_id,user_id) VALUES (?,?)", [guildId, userId]).catch(()=>{});
    const [r] = await this.db.query("SELECT * FROM eco_users WHERE guild_id=? AND user_id=?", [guildId, userId]);
    return r[0] || { guild_id:guildId, user_id:userId, coins:0, xp:0, level:1, messages:0, voice_mins:0, last_daily:0, last_work:0 };
  }

  // ── XP за сообщения ──────────────────────────────────────────
  async addMessageXP(message) {
    if (message.author.bot || !message.guild) return;
    const key = `${message.guild.id}_${message.author.id}`;
    const last = xpCooldowns.get(key) || 0;
    if (Date.now() - last < XP_COOLDOWN) return;
    xpCooldowns.set(key, Date.now());

    const guildId = message.guild.id;
    const userId  = message.author.id;
    const u       = await this.getUser(guildId, userId);
    const xpGain  = Math.floor(Math.random() * 10) + 5; // 5-15 XP
    let xp        = (u.xp || 0) + xpGain;
    let level     = u.level || 1;
    let coinsGain = 0;

    while (xp >= xpForLevel(level)) {
      xp -= xpForLevel(level);
      level++;
      coinsGain += level * 100;
      // Уведомление о повышении уровня
      try {
        await message.channel.send({
          embeds: [new EmbedBuilder()
            .setTitle("🎉 Повышение уровня!")
            .setColor(0xffd700)
            .setDescription(`<@${userId}> достиг **${level}** уровня!`)
            .addFields({ name:"💰 Награда", value:`+${level*100} монет` })
          ]
        });
      } catch {}
    }

    await this.db.query(
      "UPDATE eco_users SET xp=?, level=?, messages=messages+1, coins=coins+? WHERE guild_id=? AND user_id=?",
      [xp, level, coinsGain, guildId, userId]
    ).catch(()=>{});
  }

  // ── ПРОФИЛЬ ──────────────────────────────────────────────────
  async showProfile(interaction) {
    const target = interaction.options.getUser("пользователь") || interaction.user;
    const u = await this.getUser(interaction.guild.id, target.id);
    const need = xpForLevel(u.level || 1);
    const [rankRow] = await this.db.query(
      "SELECT COUNT(*)+1 as rank FROM eco_users WHERE guild_id=? AND (xp + level*1000) > (? + ?*1000)",
      [interaction.guild.id, u.xp||0, u.level||1]
    );
    const rank = rankRow[0]?.rank || 1;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Профиль — ${target.username}`)
      .setColor(0x3399ff)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name:"⭐ Уровень",      value:`**${u.level||1}**`,          inline:true },
        { name:"📈 XP",           value:`${u.xp||0}/${need}`,          inline:true },
        { name:"🏆 Ранг",         value:`#${rank}`,                    inline:true },
        { name:"💰 Монеты",       value:`${u.coins||0}`,               inline:true },
        { name:"💬 Сообщений",    value:`${u.messages||0}`,            inline:true },
        { name:"🎤 Голос (мин)",  value:`${u.voice_mins||0}`,          inline:true }
      ).setTimestamp();

    return interaction.reply({ embeds:[embed], ephemeral:false });
  }

  // ── ТОП ──────────────────────────────────────────────────────
  async showLeaderboard(interaction) {
    const type = interaction.options.getString("тип") || "xp";
    const col   = type === "coins" ? "coins" : "level DESC, xp";
    const [rows] = await this.db.query(
      `SELECT user_id, level, xp, coins, messages FROM eco_users WHERE guild_id=? ORDER BY ${col} DESC LIMIT 10`,
      [interaction.guild.id]
    );
    if (!rows.length) return interaction.reply({ content:"ℹ️ Нет данных.", ephemeral:true });

    const lines = rows.map((r,i) => {
      const medal = ["🥇","🥈","🥉"][i] || `${i+1}.`;
      const name  = interaction.guild.members.cache.get(r.user_id)?.user.username || r.user_id;
      const val   = type === "coins" ? `💰 ${r.coins}` : `Ур. ${r.level} | ${r.xp} XP`;
      return `${medal} **${name}** — ${val}`;
    }).join("\n");

    return interaction.reply({ embeds:[new EmbedBuilder()
      .setTitle(`🏆 Топ ${type === "coins" ? "по монетам" : "по уровням"}`)
      .setDescription(lines).setColor(0xffd700).setTimestamp()
    ]});
  }

  // ── DAILY ────────────────────────────────────────────────────
  async claimDaily(interaction) {
    const u = await this.getUser(interaction.guild.id, interaction.user.id);
    const now = Date.now();
    const cooldown = 24 * 60 * 60 * 1000;
    if (now - (u.last_daily || 0) < cooldown) {
      const left = Math.ceil((u.last_daily + cooldown - now) / 60000);
      return interaction.reply({ content:`⏳ Следующая награда через **${left} мин.**`, ephemeral:true });
    }
    const reward = Math.floor(Math.random() * 200) + 300; // 300-500
    await this.db.query("UPDATE eco_users SET coins=coins+?,last_daily=? WHERE guild_id=? AND user_id=?",
      [reward, now, interaction.guild.id, interaction.user.id]);
    return interaction.reply({ embeds:[new EmbedBuilder()
      .setTitle("🎁 Ежедневная награда")
      .setColor(0x00cc66)
      .setDescription(`Вы получили **${reward} монет**!`)
      .addFields({ name:"💰 Баланс", value:`${(u.coins||0)+reward}` })
      .setTimestamp()
    ]});
  }

  // ── РАБОТА ───────────────────────────────────────────────────
  async doWork(interaction) {
    const u = await this.getUser(interaction.guild.id, interaction.user.id);
    const now = Date.now();
    const cooldown = 60 * 60 * 1000; // 1 час
    if (now - (u.last_work || 0) < cooldown) {
      const left = Math.ceil((u.last_work + cooldown - now) / 60000);
      return interaction.reply({ content:`⏳ Следующая работа через **${left} мин.**`, ephemeral:true });
    }
    const jobs    = ["программист","дизайнер","модератор","охранник","курьер","стример","блогер"];
    const job     = jobs[Math.floor(Math.random() * jobs.length)];
    const reward  = Math.floor(Math.random() * 150) + 50;
    await this.db.query("UPDATE eco_users SET coins=coins+?,last_work=? WHERE guild_id=? AND user_id=?",
      [reward, now, interaction.guild.id, interaction.user.id]);
    return interaction.reply({ content:`💼 Вы работали **${job}** и заработали **${reward} монет**!`, ephemeral:false });
  }

  // ── БАЛАНС ───────────────────────────────────────────────────
  async showBalance(interaction) {
    const target = interaction.options.getUser("пользователь") || interaction.user;
    const u = await this.getUser(interaction.guild.id, target.id);
    return interaction.reply({ content:`💰 Баланс **${target.username}**: **${u.coins||0} монет**`, ephemeral:false });
  }

  // ── ПЕРЕДАТЬ ─────────────────────────────────────────────────
  async transfer(interaction) {
    const target = interaction.options.getUser("пользователь");
    const amount = interaction.options.getInteger("сумма");
    if (amount <= 0) return interaction.reply({ content:"❌ Сумма должна быть больше 0.", ephemeral:true });
    const u = await this.getUser(interaction.guild.id, interaction.user.id);
    if ((u.coins||0) < amount) return interaction.reply({ content:"❌ Недостаточно монет.", ephemeral:true });
    await this.db.query("UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?", [amount, interaction.guild.id, interaction.user.id]);
    await this.getUser(interaction.guild.id, target.id); // создать если нет
    await this.db.query("UPDATE eco_users SET coins=coins+? WHERE guild_id=? AND user_id=?", [amount, interaction.guild.id, target.id]);
    return interaction.reply({ content:`✅ Вы передали **${amount} монет** пользователю <@${target.id}>.`, ephemeral:false });
  }

  // ── ВЫДАТЬ МОНЕТЫ (admin) ────────────────────────────────────
  async giveCoins(interaction) {
    const target = interaction.options.getUser("пользователь");
    const amount = interaction.options.getInteger("сумма");
    await this.getUser(interaction.guild.id, target.id);
    await this.db.query("UPDATE eco_users SET coins=coins+? WHERE guild_id=? AND user_id=?", [amount, interaction.guild.id, target.id]);
    return interaction.reply({ content:`✅ Выдано **${amount} монет** пользователю <@${target.id}>.`, ephemeral:true });
  }

  // ── МАГАЗИН ──────────────────────────────────────────────────
  async showShop(interaction) {
    const [items] = await this.db.query("SELECT * FROM eco_shop WHERE guild_id=? ORDER BY sort_order", [interaction.guild.id]);
    if (!items.length) return interaction.reply({ content:"🛒 Магазин пуст. Администратор может добавить товары через /панель.", ephemeral:true });
    const embed = new EmbedBuilder()
      .setTitle("🛒 Магазин сервера").setColor(0xffd700)
      .setDescription(items.map(i=>`**${i.name}** — 💰 ${i.price} монет\n${i.description||""}`).join("\n\n"));
    return interaction.reply({ embeds:[embed], ephemeral:false });
  }
}

module.exports = { EconomyManager };
