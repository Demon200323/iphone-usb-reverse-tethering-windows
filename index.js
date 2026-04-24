// ================================================================
// AUREX-9 v3.0 | Многосерверный Discord-бот
// Модульная архитектура | MySQL2 | Groq LLM | TGD 5.2 Music
// ================================================================

const {
  Client, GatewayIntentBits, Partials,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionFlagsBits, AuditLogEvent, AttachmentBuilder
} = require("discord.js");
const mysql = require("./pg-adapter");

const { initDB }                              = require("./modules/database");
const { getGuildSetting, setGuildSetting }    = require("./modules/settings");
const { AuditLogger }                         = require("./modules/audit");
const { analyze, aiReply, aiModerate, initGroq } = require("./modules/aurex-ai");
const { ModerationManager }                   = require("./modules/moderation");
const { TicketManager }                       = require("./modules/tickets");
const { CommandRegistry }                     = require("./modules/commands");
const { EconomyManager }                      = require("./modules/economy");
const { getServerOnline }                     = require("./modules/gameserver");
const music = require("./modules/music");
const CONFIG = require("./config.json");

// ── КЛИЕНТ ───────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.GuildMember, Partials.User]
});


// Панель управления — команды, хендлеры, функции и ControlPanel
const {
  PANEL_COMMANDS,
  registerPanelCommands,
  attachPanelHandlers,
} = require("./modules/panel-commands");
 
// Функции панели — экономика, кланы, защита, авто-системы
const {
  ControlPanel,
  initPanelDatabase,
  deployMainPanel,
  sendVerificationPanel,
  addMessageXP,
  checkFlood,
  checkAntiRaid,
  startAutoEvents,
  startClanWars,
} = require("./modules/panel-functions");

// ── БАЗА ДАННЫХ ──────────────────────────────────────────────────
const db = mysql.createPool({
  host:             CONFIG.database.host,
  port:             CONFIG.database.port || 5432,
  user:             CONFIG.database.user,
  password:         CONFIG.database.password,
  database:         CONFIG.database.name,
  connectionLimit:  20,
});

// ── МЕНЕДЖЕРЫ ────────────────────────────────────────────────────
let auditLogger, ticketManager, moderationManager, controlPanel, commandRegistry, economyManager;

const floodMap   = new Map(); // guildId_userId -> timestamps[]
const aiCooldown = new Map(); // guildId_userId -> count+ts

module.exports = { client, db };


// ── ИНИЦИАЛИЗАЦИЯ ────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ AUREX-9 v3.0 онлайн как ${client.user.tag}`);
  await initDB(db);

  auditLogger       = new AuditLogger(client, db);
  moderationManager = new ModerationManager(client, db, auditLogger);
  ticketManager     = new TicketManager(client, db, auditLogger);
  controlPanel      = new ControlPanel(client, db, auditLogger);
  commandRegistry   = new CommandRegistry(client, db);
  economyManager    = new EconomyManager(client, db);

  // Инициализация Groq с глобальным ключом
  initGroq(CONFIG.groqApiKey);

  await commandRegistry.register(CONFIG.token, CONFIG.clientId);

  for (const guild of client.guilds.cache.values()) await onGuildReady(guild);

  // Периодические задачи
  setInterval(checkAnticrashHealth, 60000);
  setInterval(checkTicketAutoClose, 1800000); // каждые 30 мин

  console.log(`✅ AUREX-9 готов. Серверов: ${client.guilds.cache.size}`);
});

async function onGuildReady(guild) {
  try {
    const enabled = await getGuildSetting(db, guild.id, "enabled", true);
    if (!enabled) return;
    await ticketManager.deployPanel(guild.id);
    await deployServerStatus(guild.id);
  } catch (e) { console.error(`[${guild.name}] Ошибка инициализации:`, e.message); }
}

client.on("guildCreate", async guild => {
  console.log(`➕ Добавлен: ${guild.name}`);
  await onGuildReady(guild);
  await auditLogger.globalLog("🆕 Добавлен на новый сервер", [
    { name:"Сервер", value:guild.name }, { name:"ID", value:guild.id }
  ]);
});

// ── СТАТУС ИГРОВОГО СЕРВЕРА ──────────────────────────────────────
async function deployServerStatus(guildId) {
  const channelId = await getGuildSetting(db, guildId, "server_status_channel");
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const cfgRaw = await getGuildSetting(db, guildId, "game_server_config");
  if (!cfgRaw) return;
  const cfg = JSON.parse(cfgRaw);

  const update = async () => {
    const data  = await getServerOnline(cfg).catch(() => null);
    const on    = !!data;
    const embed = new EmbedBuilder()
      .setTitle(`🛰 ${cfg.name || "Игровой сервер"}`)
      .setDescription(on ? "🟢 Сервер **онлайн**" : "🔴 Сервер **недоступен**")
      .setColor(on ? 0x2ecc71 : 0xe74c3c)
      .addFields(
        { name:"🌐 Адрес", value:`\`${cfg.ip}:${cfg.port}\``, inline:true },
        { name:"👥 Онлайн", value:on ? `**${data.online}/${data.max}**` : "Офлайн", inline:true },
        { name:"🗺 Карта", value:on ? data.map : "—", inline:true }
      ).setTimestamp().setFooter({ text:"AUREX-9" });
    const msgs = await channel.messages.fetch({ limit:5 }).catch(() => null);
    const msg  = msgs?.find(m => m.author.id === client.user.id);
    if (msg) await msg.edit({ embeds:[embed] }).catch(() => {});
    else await channel.send({ embeds:[embed] });
  };
  await update();
  setInterval(update, 60000);
}

// ── СООБЩЕНИЯ ────────────────────────────────────────────────────
client.on("messageCreate", async message => {
  if (!message.guild || message.author.bot) return;
  const guildId = message.guild.id;

  // XP (экономика)
  if (economyManager) economyManager.addMessageXP(message).catch(() => {});

  const botEnabled = await getGuildSetting(db, guildId, "enabled", true);
  if (!botEnabled) return;

  const content = (message.content || "").slice(0,2000);

  // ── Авто-модерация ─────────────────────────────────────────
  const automodOn = await getGuildSetting(db, guildId, "automod_enabled", true);
  if (automodOn && content) {
    try {
      const result = analyze(content);
      // Применяем пользовательские веса из БД
      const wMat  = parseFloat(await getGuildSetting(db, guildId, "weight_mat",  1.5));
      const wCaps = parseFloat(await getGuildSetting(db, guildId, "weight_caps", 0.5));
      const wSpam = parseFloat(await getGuildSetting(db, guildId, "weight_spam", 1.2));
      const wPorn = parseFloat(await getGuildSetting(db, guildId, "weight_porn", 2.0));
      const score = (result.mat?wMat:0) + (result.caps?wCaps:0) + (result.spam?wSpam:0) + (result.porn?wPorn:0) +
                    (result.invite?1.8:0) + (result.suspiciousLink?2.0:0);

      if (score >= 1.5) {
        const m = await message.guild.members.fetch(message.author.id).catch(() => null);
        if (m) await moderationManager.handleViolation(m, message, result, guildId);
      }
    } catch {}
  }

  // ── Анти-флуд ──────────────────────────────────────────────
  const floodOn = await getGuildSetting(db, guildId, "flood_protection", true);
  if (floodOn) {
    const key = `${guildId}_${message.author.id}`;
    const now = Date.now();
    const arr = (floodMap.get(key) || []).filter(t => now - t < 8000);
    arr.push(now);
    floodMap.set(key, arr);
    const limit = parseInt(await getGuildSetting(db, guildId, "flood_limit", 5));
    if (arr.length >= limit) {
      const m = await message.guild.members.fetch(message.author.id).catch(() => null);
      if (m) { await moderationManager.warn(m, "Флуд (авто)", null, guildId); await message.delete().catch(() => {}); }
    }
  }

  // ── AI-чат (Groq) ──────────────────────────────────────────
  const aiChatOn = await getGuildSetting(db, guildId, "ai_chat_enabled", true);
  if (aiChatOn && (message.mentions.has(client.user) || message.content.startsWith("!aurex"))) {
    const isAnnounce = message.mentions.everyone || message.channel.name?.includes("announce");
    if (!isAnnounce) await handleAiChat(message, guildId);
  }
});

// ── AI-ЧАТ ───────────────────────────────────────────────────────
async function handleAiChat(message, guildId) {
  try {
    // Проверить блокировку
    const [blocked] = await db.query(
      "SELECT unblock_at FROM ai_blocks WHERE guild_id=? AND user_id=?",
      [guildId, message.author.id]
    );
    if (blocked.length) {
      const ub = Number(blocked[0].unblock_at);
      if (ub === -1 || ub > Date.now()) {
        const left = ub === -1 ? "навсегда" : `${Math.ceil((ub-Date.now())/60000)} мин.`;
        return message.reply(`⛔ Вы временно не можете обращаться к AI. Осталось: ${left}`).catch(()=>{});
      }
      // Блок истёк — удаляем
      await db.query("DELETE FROM ai_blocks WHERE guild_id=? AND user_id=?", [guildId, message.author.id]);
    }

    // Суточный лимит
    const limit = parseInt(await getGuildSetting(db, guildId, "ai_daily_limit", 5));
    const cutoff = Date.now() - 86400000;
    await db.query("DELETE FROM ai_daily_chat WHERE guild_id=? AND user_id=? AND ts<?", [guildId, message.author.id, cutoff]);
    const [counts] = await db.query("SELECT COUNT(*) as c FROM ai_daily_chat WHERE guild_id=? AND user_id=?", [guildId, message.author.id]);
    if (counts[0].c >= limit) {
      const oldest = await db.query("SELECT ts FROM ai_daily_chat WHERE guild_id=? AND user_id=? ORDER BY ts ASC LIMIT 1", [guildId, message.author.id]);
      const resetAt = (oldest[0]?.[0]?.ts || Date.now()) + 86400000;
      const left = Math.ceil((resetAt - Date.now()) / 60000);
      // Применяем блок
      await db.query("INSERT INTO ai_blocks (guild_id,user_id,unblock_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE unblock_at=?", [guildId, message.author.id, resetAt, resetAt]);
      return message.reply(`⛔ Лимит AI исчерпан. Следующий сброс через **${left} мин.**`).catch(()=>{});
    }

    await db.query("INSERT INTO ai_daily_chat (guild_id,user_id,ts) VALUES (?,?,?)", [guildId, message.author.id, Date.now()]);

    // Получить настройки
    const systemPrompt = await getGuildSetting(db, guildId, "ai_system_prompt");
    const rules        = await getRules(guildId, "server");
    const groqKey      = await getGuildSetting(db, guildId, "groq_api_key");
    if (groqKey) initGroq(groqKey); // персональный ключ сервера

    const reply = await aiReply(message, systemPrompt, message.guild.name, rules);
    if (reply) await message.reply(reply.slice(0,1990)).catch(() => {});
  } catch (e) { console.error("[aiChat]", e.message); }
}

async function getRules(guildId, type) {
  const [rows] = await db.query("SELECT content FROM server_rules WHERE guild_id=? AND type=? LIMIT 1", [guildId, type]);
  return rows[0]?.content || null;
}

// ── СОБЫТИЯ КАНАЛОВ / БАНОВ / УЧАСТНИКОВ ─────────────────────────
client.on("messageUpdate", (o, n) => {
  if (!n.guild || o.content === n.content) return;
  auditLogger.guildLog(n.guild.id, "✏️ Сообщение изменено", [
    { name:"Автор", value:`<@${n.author?.id}>` }, { name:"Канал", value:`<#${n.channel.id}>` },
    { name:"Было",  value:(o.content||"—").slice(0,800) }, { name:"Стало", value:(n.content||"—").slice(0,800) }
  ], 0xffaa00);
});

client.on("messageDelete", m => {
  if (!m.guild) return;
  auditLogger.guildLog(m.guild.id, "🗑️ Сообщение удалено", [
    { name:"Автор", value:`<@${m.author?.id}>` }, { name:"Канал", value:`<#${m.channel.id}>` },
    { name:"Текст", value:(m.content||"—").slice(0,800) }
  ], 0x777777);
});

client.on("guildMemberAdd", m => auditLogger.guildLog(m.guild.id, "✅ Участник вошёл", [{ name:"Пользователь", value:`<@${m.id}>` }], 0x00cc66));
client.on("guildMemberRemove", m => auditLogger.guildLog(m.guild.id, "❌ Участник вышел", [{ name:"Пользователь", value:`<@${m.id}>` }], 0xcc0000));

client.on("guildMemberUpdate", (o, n) => {
  const added   = n.roles.cache.filter(r => !o.roles.cache.has(r.id));
  const removed = o.roles.cache.filter(r => !n.roles.cache.has(r.id));
  if (!added.size && !removed.size) return;
  auditLogger.guildLog(n.guild.id, "🛡️ Роли изменены", [
    { name:"Пользователь", value:`<@${n.id}>` },
    { name:"Добавлено",   value:added.map(r=>`<@&${r.id}>`).join(" ")||"—" },
    { name:"Удалено",     value:removed.map(r=>`<@&${r.id}>`).join(" ")||"—" }
  ], 0x3366ff);
});

client.on("channelCreate", c => c.guild && auditLogger.guildLog(c.guild.id, "📁 Канал создан", [{ name:"Имя", value:c.name }], 0x00ccff));

// ── АНТИ-КРАШ: УДАЛЕНИЕ КАНАЛОВ ─────────────────────────────────
client.on("channelDelete", async channel => {
  if (!channel.guild) return;
  const guild   = channel.guild;
  const guildId = guild.id;

  auditLogger.guildLog(guildId, "🗑️ Канал удалён", [
    { name:"Имя", value:channel.name||"—" }, { name:"ID", value:channel.id }
  ], 0xff3300);

  try {
    const anticrashOn = await getGuildSetting(db, guildId, "anticrash_enabled", true);
    if (!anticrashOn) return;

    const audit = await guild.fetchAuditLogs({ type:AuditLogEvent.ChannelDelete, limit:1 }).catch(() => null);
    const entry = audit?.entries.first();
    if (!entry?.executor || entry.executor.bot) return;

    const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
    if (!executor) return;

    const immuneRoles = JSON.parse(await getGuildSetting(db, guildId, "immune_roles", "[]"));
    if (immuneRoles.some(r => executor.roles.cache.has(r))) return;

    // Записать в лог
    await db.query(
      "INSERT INTO channel_delete_log (guild_id,executor,channel_name,created_at) VALUES (?,?,?,?)",
      [guildId, executor.id, channel.name||"?", Date.now()]
    );

    // Проверить лимит за последние 2 минуты
    const limit = parseInt(await getGuildSetting(db, guildId, "anticrash_chan_limit", 3));
    const [recent] = await db.query(
      "SELECT COUNT(*) as c FROM channel_delete_log WHERE guild_id=? AND executor=? AND created_at>?",
      [guildId, executor.id, Date.now() - 120000]
    );

    if (recent[0].c >= limit) {
      await moderationManager.punishMod(executor, `Массовое удаление каналов (${recent[0].c} за 2 мин.)`, guildId);
      await auditLogger.guildLog(guildId, "🛡️ АНТИ-КРАШ: Удаление каналов", [
        { name:"Виновник", value:`<@${executor.id}>` },
        { name:"Удалено каналов", value:String(recent[0].c) }
      ], 0xff0000);
    }
  } catch (e) { console.error("[channelDelete anticrash]", e.message); }
});

client.on("roleCreate", r => auditLogger.guildLog(r.guild.id, "🏷️ Роль создана", [{ name:"Название", value:r.name }], 0x00ccff));
client.on("roleDelete", r => auditLogger.guildLog(r.guild.id, "🗑️ Роль удалена", [{ name:"Название", value:r.name }], 0xff0000));
client.on("guildBanAdd", b => auditLogger.guildLog(b.guild.id, "⛔ Бан", [{ name:"Пользователь", value:`<@${b.user.id}>` }], 0xaa0000));
client.on("guildBanRemove", b => auditLogger.guildLog(b.guild.id, "✅ Разбан", [{ name:"Пользователь", value:`<@${b.user.id}>` }], 0x00aa00));

client.on("voiceStateUpdate", (o, n) => {
  if (o.channelId === n.channelId) return;
  auditLogger.guildLog(n.guild?.id, "🎤 Голосовой переход", [
    { name:"Пользователь", value:`<@${n.id}>` },
    { name:"Было",  value:o.channelId ? `<#${o.channelId}>` : "—" },
    { name:"Стало", value:n.channelId ? `<#${n.channelId}>` : "—" }
  ], 0x9933ff);
});

// ── АНТИ-КРАШ: МАССОВЫЕ БАНЫ ────────────────────────────────────
client.on("guildBanAdd", async ban => {
  const { guild, user } = ban;
  try {
    const anticrashOn = await getGuildSetting(db, guild.id, "anticrash_enabled", true);
    if (!anticrashOn) return;
    const audit = await guild.fetchAuditLogs({ type:AuditLogEvent.MemberBanAdd, limit:1 }).catch(() => null);
    const entry = audit?.entries.first();
    if (!entry?.executor || entry.executor.bot) return;
    const executor = await guild.members.fetch(entry.executor.id).catch(() => null);
    if (!executor) return;
    const immuneRoles = JSON.parse(await getGuildSetting(db, guild.id, "immune_roles", "[]"));
    if (immuneRoles.some(r => executor.roles.cache.has(r))) return;
    await db.query("INSERT INTO bans_log (guild_id,moderator,user,created_at) VALUES (?,?,?,?)", [guild.id, executor.id, user.id, Date.now()]);
    const limit = parseInt(await getGuildSetting(db, guild.id, "anticrash_ban_limit", 5));
    const [recent] = await db.query("SELECT COUNT(*) as c FROM bans_log WHERE guild_id=? AND moderator=? AND created_at>?", [guild.id, executor.id, Date.now()-60000]);
    if (recent[0].c >= limit) {
      await moderationManager.punishMod(executor, `Массовый бан (${recent[0].c} за 60 сек.)`, guild.id);
      const banned = await guild.bans.fetch();
      for (const [id] of banned) await guild.bans.remove(id).catch(() => {});
      await auditLogger.guildLog(guild.id, "🛡️ АНТИ-КРАШ: Массовый бан отменён", [
        { name:"Виновник", value:`<@${executor.id}>` },
        { name:"Разбанено", value:String(banned.size) }
      ], 0xff0000);
    }
  } catch (e) { console.error("[anticrash ban]", e.message); }
});

// ── ВЗАИМОДЕЙСТВИЯ ───────────────────────────────────────────────
client.on("interactionCreate", async interaction => {
  try {
    if (!interaction.guild) return;
    const guildId = interaction.guild.id;

    // Бот отключён — только ctrl_enable_bot и панель проходят
    const botEnabled = await getGuildSetting(db, guildId, "enabled", true);
    if (!botEnabled) {
      if (interaction.isChatInputCommand() && interaction.commandName === "панель") {
        return await controlPanel.sendPanel(interaction);
      }
      if (interaction.isButton() && interaction.customId === "ctrl_enable_bot") {
        return await controlPanel.handleButton(interaction);
      }
      if (!interaction.replied && !interaction.deferred)
        return interaction.reply({ content:"❌ Бот отключён. Введите /панель чтобы включить.", ephemeral:true }).catch(() => {});
      return;
    }

    if (interaction.isChatInputCommand())    return await handleSlash(interaction);
    if (interaction.isButton())              return await handleButton(interaction);
    if (interaction.isStringSelectMenu())    return await handleSelect(interaction);
    if (interaction.isModalSubmit())         return await handleModal(interaction);
  } catch (e) {
    console.error("[interaction]", e);
    if (!interaction.replied && !interaction.deferred)
      interaction.reply({ content:"❌ Ошибка. Попробуйте снова.", ephemeral:true }).catch(() => {});
  }
});

// ── SLASH КОМАНДЫ ────────────────────────────────────────────────
async function handleSlash(interaction) {
  const { commandName, guild, member, user } = interaction;
  const guildId = guild.id;

  switch (commandName) {
    case "панель":    return await controlPanel.sendPanel(interaction);
    case "настройки": return await controlPanel.handleSettingsCommand(interaction);

    // ── МОДЕРАЦИЯ ──
    case "варн": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const reason = interaction.options.getString("причина");
      const m = await guild.members.fetch(target.id).catch(() => null);
      if (!m) return interaction.reply({ content:"❌ Пользователь не найден.", ephemeral:true });
      await moderationManager.warn(m, reason, member, guildId);
      return interaction.reply({ content:`⚠️ Предупреждение выдано **${target.username}**: ${reason}`, ephemeral:true });
    }
    case "снятьварн": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      await db.query("DELETE FROM warnings WHERE user=? AND guild_id=?", [target.id, guildId]);
      return interaction.reply({ content:`✅ Предупреждения сняты у **${target.username}**`, ephemeral:true });
    }
    case "предупреждения": {
      const target = interaction.options.getUser("пользователь");
      const [rows] = await db.query("SELECT count FROM warnings WHERE user=? AND guild_id=?", [target.id, guildId]);
      return interaction.reply({ content:`📊 У **${target.username}**: **${rows[0]?.count||0}/3** предупреждений`, ephemeral:true });
    }
    case "мут": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const mins   = interaction.options.getInteger("минуты") || 10;
      const reason = interaction.options.getString("причина") || "Без причины";
      const m = await guild.members.fetch(target.id).catch(() => null);
      if (!m) return interaction.reply({ content:"❌ Пользователь не найден.", ephemeral:true });
      await m.timeout(mins * 60000, reason);
      await moderationManager.logAction(guildId, user.id, target.id, "mute", reason, mins*60000);
      await auditLogger.guildLog(guildId, "🔇 Мут выдан", [
        { name:"Пользователь", value:`<@${target.id}>` }, { name:"Причина", value:reason },
        { name:"Длительность", value:`${mins} мин.` }, { name:"Выдал", value:`<@${user.id}>` }
      ]);
      return interaction.reply({ content:`🔇 **${target.username}** замучен на **${mins} мин.**`, ephemeral:true });
    }
    case "снятьмут": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const m = await guild.members.fetch(target.id).catch(() => null);
      if (m) await m.timeout(null);
      return interaction.reply({ content:`✅ Мут снят с **${target.username}**`, ephemeral:true });
    }
    case "кик": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const reason = interaction.options.getString("причина") || "Без причины";
      const m = await guild.members.fetch(target.id).catch(() => null);
      if (!m) return interaction.reply({ content:"❌ Пользователь не найден.", ephemeral:true });
      await m.kick(reason);
      await moderationManager.logAction(guildId, user.id, target.id, "kick", reason);
      return interaction.reply({ content:`👢 **${target.username}** кикнут.`, ephemeral:true });
    }
    case "бан": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const reason = interaction.options.getString("причина") || "Без причины";
      const days   = interaction.options.getInteger("дни") || 0;
      await guild.members.ban(target.id, { reason, deleteMessageSeconds: days * 86400 });
      await moderationManager.logAction(guildId, user.id, target.id, "ban", reason);
      return interaction.reply({ content:`⛔ **${target.username}** забанен.`, ephemeral:true });
    }
    case "разбан": {
      if (!await hasPerm(interaction)) return;
      const id = interaction.options.getString("id");
      await guild.bans.remove(id).catch(() => {});
      return interaction.reply({ content:`✅ Пользователь ${id} разбанен.`, ephemeral:true });
    }
    case "очистить": {
      if (!await hasPerm(interaction)) return;
      const count  = interaction.options.getInteger("количество") || 10;
      const target = interaction.options.getUser("пользователь");
      let msgs     = await interaction.channel.messages.fetch({ limit:100 }).catch(() => null);
      if (target) msgs = msgs?.filter(m => m.author.id === target.id);
      const toDelete = msgs ? [...msgs.values()].slice(0, count) : [];
      await interaction.channel.bulkDelete(toDelete, true).catch(() => {});
      await moderationManager.logAction(guildId, user.id, target?.id||"bulk", "delete", `Удалено ${toDelete.length} сообщений`);
      return interaction.reply({ content:`🗑️ Удалено **${toDelete.length}** сообщений.`, ephemeral:true });
    }
    case "медленный": {
      if (!await hasPerm(interaction)) return;
      const secs = interaction.options.getInteger("секунды");
      await interaction.channel.setRateLimitPerUser(secs);
      return interaction.reply({ content:secs ? `🐢 Медленный режим: **${secs} сек.**` : "✅ Медленный режим отключён.", ephemeral:true });
    }
    case "заблокировать": {
      if (!await hasPerm(interaction)) return;
      const reason = interaction.options.getString("причина") || "Блокировка каналa";
      await interaction.channel.permissionOverwrites.edit(guild.id, { SendMessages:false });
      return interaction.reply({ content:`🔒 Канал заблокирован. Причина: ${reason}` });
    }
    case "разблокировать": {
      if (!await hasPerm(interaction)) return;
      await interaction.channel.permissionOverwrites.edit(guild.id, { SendMessages:null });
      return interaction.reply({ content:"🔓 Канал разблокирован." });
    }
    case "история": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const type   = interaction.options.getString("тип") || "all";
      const where  = type === "all" ? "" : `AND action='${type}'`;
      const [rows] = await db.query(
        `SELECT action,reason,created_at FROM mod_actions WHERE guild_id=? AND (mod_id=? OR target_id=?) ${where} ORDER BY created_at DESC LIMIT 20`,
        [guildId, target.id, target.id]
      );
      if (!rows.length) return interaction.reply({ content:"ℹ️ История пуста.", ephemeral:true });
      const text = rows.map(r => `<t:${Math.floor(r.created_at/1000)}:R> **${r.action}** — ${r.reason||"—"}`).join("\n");
      return interaction.reply({ embeds:[new EmbedBuilder().setTitle(`📜 История — ${target.username}`).setDescription(text).setColor(0x3399ff)], ephemeral:true });
    }
    case "снятьмодер": {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content:"❌ Только администраторы.", ephemeral:true });
      const target = interaction.options.getUser("пользователь");
      const reason = interaction.options.getString("причина");
      const m = await guild.members.fetch(target.id).catch(() => null);
      if (!m) return interaction.reply({ content:"❌ Пользователь не найден.", ephemeral:true });
      await moderationManager.punishMod(m, reason, guildId);
      return interaction.reply({ content:`🚨 Модератор **${target.username}** снят. Причина: ${reason}`, ephemeral:true });
    }

    // ── ТИКЕТЫ ──
    case "тикет": {
      const sub = interaction.options.getSubcommand();
      if (sub === "создать")  return await ticketManager.createFromCommand(interaction);
      if (sub === "закрыть")  return await ticketManager.closeFromCommand(interaction);
      if (sub === "добавить") return await ticketManager.addUser(interaction);
      if (sub === "список")   return await ticketManager.listTickets(interaction);
      if (sub === "панель")   return await ticketManager.deployPanelCommand(interaction);
      break;
    }

    // ── ИНФОРМАЦИЯ ──
    case "профиль": {
      const target = interaction.options.getUser("пользователь") || user;
      const [stats] = await db.query("SELECT * FROM mod_stats WHERE mod_id=? AND guild_id=?", [target.id, guildId]);
      const [warns] = await db.query("SELECT count FROM warnings WHERE user=? AND guild_id=?", [target.id, guildId]);
      const s = stats[0], w = warns[0]?.count || 0;
      return interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle(`📊 Профиль — ${target.username}`)
        .setColor(0x3399ff)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name:"⚠️ Предупреждения",    value:`${w}/3`, inline:true },
          { name:"🎫 Тикетов",           value:String(s?.tickets_handled||0), inline:true },
          { name:"⚔️ Варнов выдано",     value:String(s?.warns_issued||0), inline:true },
          { name:"🔇 Мутов выдано",      value:String(s?.mutes_issued||0), inline:true },
          { name:"⛔ Банов выдано",      value:String(s?.bans_issued||0), inline:true },
          { name:"🕐 Активность",        value:s?.last_active ? `<t:${Math.floor(s.last_active/1000)}:R>` : "—", inline:true }
        ).setTimestamp()
      ], ephemeral:true });
    }
    case "рейтинг": {
      const [rows] = await db.query("SELECT * FROM mod_stats WHERE guild_id=? ORDER BY tickets_handled+warns_issued+mutes_issued DESC LIMIT 10", [guildId]);
      if (!rows.length) return interaction.reply({ content:"ℹ️ Нет данных.", ephemeral:true });
      const text = rows.map((r,i) => {
        const name = guild.members.cache.get(r.mod_id)?.user.username || r.mod_id;
        return `${["🥇","🥈","🥉"][i]||`${i+1}.`} **${name}** — 🎫${r.tickets_handled} ⚠️${r.warns_issued} 🔇${r.mutes_issued}`;
      }).join("\n");
      return interaction.reply({ embeds:[new EmbedBuilder().setTitle("🏆 Рейтинг модераторов").setDescription(text).setColor(0xffd700)], ephemeral:false });
    }
    case "сервер": {
      return interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle(`🏛 ${guild.name}`)
        .setColor(0x3399ff)
        .setThumbnail(guild.iconURL())
        .addFields(
          { name:"👤 Участников",  value:String(guild.memberCount), inline:true },
          { name:"📅 Создан",      value:`<t:${Math.floor(guild.createdTimestamp/1000)}:D>`, inline:true },
          { name:"🔰 Верификация", value:guild.verificationLevel.toString(), inline:true }
        )
      ]});
    }
    case "пользователь": {
      const target = interaction.options.getUser("пользователь") || user;
      const m = await guild.members.fetch(target.id).catch(() => null);
      return interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle(`👤 ${target.username}`)
        .setColor(0x3399ff)
        .setThumbnail(target.displayAvatarURL())
        .addFields(
          { name:"📅 Аккаунт создан", value:`<t:${Math.floor(target.createdTimestamp/1000)}:D>`, inline:true },
          { name:"📥 Зашёл",          value:m ? `<t:${Math.floor(m.joinedTimestamp/1000)}:D>` : "—", inline:true },
          { name:"🎭 Ролей",          value:String(m?.roles.cache.size||0), inline:true }
        )
      ], ephemeral:true });
    }
    case "правила": {
      const rulesOn = await getGuildSetting(db, guildId, "rules_enabled", true);
      if (!rulesOn) return interaction.reply({ content:"ℹ️ Правила не настроены.", ephemeral:true });
      const [sRows] = await db.query("SELECT title,content FROM server_rules WHERE guild_id=? AND type='server' LIMIT 1", [guildId]);
      const [dRows] = await db.query("SELECT title,content FROM server_rules WHERE guild_id=? AND type='discord' LIMIT 1", [guildId]);
      const [aRows] = await db.query("SELECT title,content FROM server_rules WHERE guild_id=? AND type='ai' LIMIT 1", [guildId]);
      const embeds  = [];
      if (sRows[0]) embeds.push(new EmbedBuilder().setTitle(`📋 ${sRows[0].title}`).setDescription(sRows[0].content.slice(0,4000)).setColor(0x3399ff));
      if (dRows[0]) embeds.push(new EmbedBuilder().setTitle(`⚖️ ${dRows[0].title}`).setDescription(dRows[0].content.slice(0,4000)).setColor(0x7289da));
      if (aRows[0]) embeds.push(new EmbedBuilder().setTitle(`🤖 ${aRows[0].title}`).setDescription(aRows[0].content.slice(0,4000)).setColor(0x9900ff));
      if (!embeds.length) return interaction.reply({ content:"ℹ️ Правила ещё не добавлены. Используйте /панель → 📜 Правила.", ephemeral:true });
      return interaction.reply({ embeds, ephemeral:false });
    }

    // ── ЭКОНОМИКА ──
    case "баланс":     return await economyManager.showBalance(interaction);
    case "ежедневно":  return await economyManager.claimDaily(interaction);
    case "работа":     return await economyManager.doWork(interaction);
    case "перевести":  return await economyManager.transfer(interaction);
    case "топ":        return await economyManager.showLeaderboard(interaction);
    case "магазин":    return await economyManager.showShop(interaction);
    case "дать": {
      if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content:"❌ Только администраторы.", ephemeral:true });
      return await economyManager.giveCoins(interaction);
    }

    // ── МУЗЫКА ──
    case "играть":    return await music.handlePlay(interaction, db);
    case "пауза":     return music.handleControl(interaction, "pause");
    case "продолжить":return music.handleControl(interaction, "resume");
    case "пропустить":return music.handleControl(interaction, "skip");
    case "стоп":      return music.handleControl(interaction, "stop");
    case "очередь":   return music.handleQueue(interaction);
    case "громкость": return music.handleVolume(interaction);
    case "повтор":    return music.handleControl(interaction, "loop");

    // ── AI ──
    case "aiблок": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      const mins   = interaction.options.getInteger("минуты");
      const reason = interaction.options.getString("причина") || "Без причины";
      const ub     = mins === 0 ? -1 : Date.now() + mins * 60000;
      await db.query("INSERT INTO ai_blocks (guild_id,user_id,unblock_at,reason) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE unblock_at=?,reason=?",
        [guildId, target.id, ub, reason, ub, reason]);
      return interaction.reply({ content:`🤖 AI-блок установлен для <@${target.id}>. ${mins===0?"Навсегда":`На ${mins} мин.`}`, ephemeral:true });
    }
    case "aiразблок": {
      if (!await hasPerm(interaction)) return;
      const target = interaction.options.getUser("пользователь");
      await db.query("DELETE FROM ai_blocks WHERE guild_id=? AND user_id=?", [guildId, target.id]);
      await db.query("DELETE FROM ai_daily_chat WHERE guild_id=? AND user_id=?", [guildId, target.id]);
      return interaction.reply({ content:`✅ AI-блок снят с <@${target.id}>.`, ephemeral:true });
    }
  }
}

// ── КНОПКИ ───────────────────────────────────────────────────────
async function handleButton(interaction) {
  const id = interaction.customId;
  if (id.startsWith("ctrl_"))   return await controlPanel.handleButton(interaction)
    .catch(() => controlPanel.handleAiSubButton(interaction, interaction.guild.id));
  if (id.startsWith("ticket_")) return await ticketManager.handleButton(interaction);
  if (id.startsWith("music_"))  {
    // Музыкальные кнопки обрабатываются коллекторами внутри playSong.
    // Но interaction нужно подтвердить чтобы Discord не показывал "Ошибка взаимодействия".
    await interaction.deferUpdate().catch(() => {});
    return;
  }
}

// ── МЕНЮ ─────────────────────────────────────────────────────────
async function handleSelect(interaction) {
  const id = interaction.customId;
  if (id === "ticket_category_select") return await ticketManager.handleCategorySelect(interaction);
  if (id.startsWith("ctrl_"))          return await controlPanel.handleSelect(interaction);
}

// ── МОДАЛИ ───────────────────────────────────────────────────────
async function handleModal(interaction) {
  const id = interaction.customId;
  if (id.startsWith("ticket_modal_")) return await ticketManager.handleModal(interaction);
  if (id.startsWith("ctrl_modal_"))   return await controlPanel.handleModal(interaction);
}

// ── ПРАВА ────────────────────────────────────────────────────────
async function hasPerm(interaction) {
  if (interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  const modRoles = JSON.parse(await getGuildSetting(db, interaction.guild.id, "mod_roles", "[]"));
  if (modRoles.some(r => interaction.member.roles.cache.has(r))) return true;
  await interaction.reply({ content:"❌ Недостаточно прав.", ephemeral:true });
  return false;
}

// ── АВТО-ЗАКРЫТИЕ ТИКЕТОВ ────────────────────────────────────────
async function checkTicketAutoClose() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const hours = parseInt(await getGuildSetting(db, guild.id, "ticket_auto_close_hours", 48));
      const cutoff = Date.now() - hours * 3600000;
      const [rows] = await db.query(
        "SELECT ticket_id,channel_id FROM tickets WHERE guild_id=? AND status='open' AND updated_at<?",
        [guild.id, cutoff]
      );
      for (const r of rows) {
        await db.query("UPDATE tickets SET status='closed',closed_reason=?,closed_at=? WHERE ticket_id=?",
          ["Авто-закрытие по неактивности", Date.now(), r.ticket_id]);
        const ch = await client.channels.fetch(r.channel_id).catch(() => null);
        if (ch) {
          await ch.send("🔒 Тикет автоматически закрыт по причине неактивности.").catch(() => {});
          setTimeout(() => ch.delete().catch(() => {}), 30000);
        }
      }
    } catch {}
  }
}

// ── ЗДОРОВЬЕ АНТИ-КРАШ ────────────────────────────────────────────
async function checkAnticrashHealth() {
  // Очистка старых записей
  await db.query("DELETE FROM bans_log WHERE created_at<?", [Date.now() - 3600000]).catch(() => {});
  await db.query("DELETE FROM channel_delete_log WHERE created_at<?", [Date.now() - 3600000]).catch(() => {});
}

process.on("unhandledRejection", e => console.error("[Rejection]", e?.message || e));
process.on("uncaughtException",  e => console.error("[Exception]", e?.message || e));

client.login(CONFIG.token);