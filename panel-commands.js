// ═══════════════════════════════════════════════════════════════
//  modules/panel-commands.js — AUREX-9 v3.0
//  Slash-команды панели: /панель, /настройки, /дуэль, /деплой
//  и все обработчики InteractionCreate для панели
// ═══════════════════════════════════════════════════════════════

const {
  Events,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  ControlPanel,
} = require("./panel-functions");

const {
  deployMainPanel,
  sendVerificationPanel,
  showProfile,
  showBalance,
  showTop,
  claimDaily,
  doWork,
  openCase,
  showBgShop,
  showInventory,
  showMarket,
  buyBackground,
  buyXPBuff,
  createClan,
  showClan,
  showServerStats,
  showModControl,
  showAurexStats,
  handleVerification,
  buyMarketItem,
  duelChallenge,
  handleDuelAccept,
  addMessageXP,
  checkFlood,
  checkGifSpam,
} = require("./panel-functions");

// ─── SLASH КОМАНДЫ ────────────────────────────────────────────
const PANEL_COMMANDS = [

  // ── Главная панель / настройки ──────────────────────────────
  new SlashCommandBuilder()
    .setName("панель")
    .setDescription("⚙️ Открыть панель управления AUREX-9 (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("настройки")
    .setDescription("⚙️ Открыть настройки бота")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Деплой панелей ─────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("деплой-панель")
    .setDescription("🚀 Развернуть экономическую панель в текущем канале (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("деплой-верификация")
    .setDescription("🔒 Развернуть кнопку верификации в текущем канале (Admin)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  // ── Экономика ───────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("профиль")
    .setDescription("📊 Просмотр профиля и статистики")
    .addUserOption(o => o
      .setName("пользователь")
      .setDescription("Пользователь (по умолчанию — ты)")),

  new SlashCommandBuilder()
    .setName("баланс")
    .setDescription("💰 Показать баланс монет")
    .addUserOption(o => o
      .setName("пользователь")
      .setDescription("Пользователь (по умолчанию — ты)")),

  new SlashCommandBuilder()
    .setName("ежедневно")
    .setDescription("🎁 Получить ежедневную награду"),

  new SlashCommandBuilder()
    .setName("работа")
    .setDescription("💼 Заработать монеты (кулдаун 1 час)"),

  new SlashCommandBuilder()
    .setName("кейс")
    .setDescription("🎰 Открыть кейс (стоит 100 монет)"),

  new SlashCommandBuilder()
    .setName("топ")
    .setDescription("🏆 Таблица лидеров сервера")
    .addStringOption(o => o
      .setName("тип")
      .setDescription("По чему сортировать")
      .addChoices(
        { name: "По уровням / XP", value: "xp" },
        { name: "По монетам",      value: "coins" }
      )),

  new SlashCommandBuilder()
    .setName("магазин-фонов")
    .setDescription("🎨 Магазин фонов для профиля"),

  new SlashCommandBuilder()
    .setName("инвентарь")
    .setDescription("🎒 Посмотреть свой инвентарь"),

  new SlashCommandBuilder()
    .setName("рынок")
    .setDescription("🛒 Просмотр рынка игроков"),

  new SlashCommandBuilder()
    .setName("купить-рынок")
    .setDescription("💸 Купить товар с рынка")
    .addIntegerOption(o => o
      .setName("id")
      .setDescription("ID товара с рынка")
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName("продать")
    .setDescription("📤 Выставить предмет из инвентаря на рынок")
    .addStringOption(o => o
      .setName("предмет")
      .setDescription("Название предмета из инвентаря")
      .setRequired(true))
    .addIntegerOption(o => o
      .setName("цена")
      .setDescription("Цена в монетах")
      .setMinValue(1)
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName("xp-буфф")
    .setDescription("⚡ Купить буфф x2 XP на 2 часа (500 монет)"),

  new SlashCommandBuilder()
    .setName("перевести")
    .setDescription("💸 Передать монеты другому пользователю")
    .addUserOption(o => o
      .setName("пользователь")
      .setDescription("Кому перевести")
      .setRequired(true))
    .addIntegerOption(o => o
      .setName("сумма")
      .setDescription("Сумма монет")
      .setMinValue(1)
      .setRequired(true)),

  new SlashCommandBuilder()
    .setName("дать-монеты")
    .setDescription("💰 (Admin) Выдать монеты пользователю")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o
      .setName("пользователь")
      .setDescription("Кому выдать")
      .setRequired(true))
    .addIntegerOption(o => o
      .setName("сумма")
      .setDescription("Сумма монет")
      .setRequired(true)),

  // ── Кланы ───────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("клан")
    .setDescription("🧬 Управление кланом")
    .addSubcommand(s => s.setName("создать").setDescription("Создать клан"))
    .addSubcommand(s => s.setName("инфо").setDescription("Информация о своём клане"))
    .addSubcommand(s => s
      .setName("пригласить")
      .setDescription("Пригласить участника в клан")
      .addUserOption(o => o.setName("пользователь").setDescription("Кого пригласить").setRequired(true)))
    .addSubcommand(s => s
      .setName("выгнать")
      .setDescription("Выгнать участника из клана")
      .addUserOption(o => o.setName("пользователь").setDescription("Кого выгнать").setRequired(true)))
    .addSubcommand(s => s.setName("распустить").setDescription("Распустить свой клан")),

  // ── Дуэль ───────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("дуэль")
    .setDescription("⚔️ Вызвать другого участника на дуэль")
    .addUserOption(o => o
      .setName("пользователь")
      .setDescription("Кого вызвать")
      .setRequired(true))
    .addIntegerOption(o => o
      .setName("ставка")
      .setDescription("Сумма монет на кону")
      .setMinValue(50)
      .setRequired(true)),

  // ── Статистика ──────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName("статистика-сервера")
    .setDescription("📊 Полная статистика сервера"),

  // ── Мод-контроль (уже есть в commands.js, тут дополнения) ──
  new SlashCommandBuilder()
    .setName("мод-контроль")
    .setDescription("👮 (Admin) Панель контроля модераторов")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("aurex-статус")
    .setDescription("🧠 (Admin) Статистика AUREX-AI — точность и веса")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

].map(c => c.toJSON());

// ─── РЕГИСТРАЦИЯ КОМАНД ───────────────────────────────────────
async function registerPanelCommands(token, clientId) {
  const rest = new REST({ version: "10" }).setToken(token);
  try {
    console.log("[Panel] 🔄 Регистрация panel slash-команд...");
    // Получаем уже зарегистрированные команды и дополняем
    const existing = await rest.get(Routes.applicationCommands(clientId)).catch(() => []);
    const existingNames = new Set(existing.map(c => c.name));
    const newCmds = PANEL_COMMANDS.filter(c => !existingNames.has(c.name));

    if (!newCmds.length) {
      console.log("[Panel] ✅ Все panel-команды уже зарегистрированы.");
      return;
    }

    await rest.put(Routes.applicationCommands(clientId), {
      body: [...existing, ...newCmds]
    });
    console.log(`[Panel] ✅ Зарегистрировано ${newCmds.length} новых команд.`);
  } catch (e) {
    console.error("[Panel] ❌ Ошибка регистрации команд:", e.message);
  }
}

// ─── РОУТЕР slash-команд + кнопок панели ─────────────────────
function attachPanelHandlers(client, db, auditLogger) {

  const controlPanel = new ControlPanel(client, db, auditLogger);

  // ── XP за каждое сообщение ────────────────────────────────
  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot || !msg.guild) return;
    try { await addMessageXP(msg); } catch {}
  });

  // ── Slash-команды ─────────────────────────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName, guild, member, user } = interaction;
    if (!guild) return;

    // ── Главная панель управления ──────────────────────────
    if (commandName === "панель" || commandName === "настройки") {
      return controlPanel.sendPanel(interaction);
    }

    // ── Деплой ─────────────────────────────────────────────
    if (commandName === "деплой-панель") {
      if (!member.permissions.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content: "❌ Только администраторы.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      await deployMainPanel(interaction.channel, guild.id, db);
      return interaction.editReply("✅ Панель развёрнута!");
    }

    if (commandName === "деплой-верификация") {
      if (!member.permissions.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content: "❌ Только администраторы.", ephemeral: true });
      await sendVerificationPanel(interaction.channel, guild.id, db);
      return interaction.reply({ content: "✅ Панель верификации развёрнута!", ephemeral: true });
    }

    // ── Экономика ──────────────────────────────────────────
    if (commandName === "профиль") {
      await interaction.deferReply();
      return showProfile(interaction, db);
    }

    if (commandName === "баланс") {
      await interaction.deferReply({ ephemeral: true });
      return showBalance(interaction, db);
    }

    if (commandName === "ежедневно") {
      await interaction.deferReply({ ephemeral: true });
      return claimDaily(interaction, db);
    }

    if (commandName === "работа") {
      await interaction.deferReply({ ephemeral: false });
      return doWork(interaction, db);
    }

    if (commandName === "кейс") {
      await interaction.deferReply({ ephemeral: true });
      return openCase(interaction, db);
    }

    if (commandName === "топ") {
      await interaction.deferReply();
      const type = interaction.options.getString("тип") || "xp";
      return showTop(interaction, db, type);
    }

    if (commandName === "магазин-фонов") {
      await interaction.deferReply({ ephemeral: true });
      return showBgShop(interaction, db);
    }

    if (commandName === "инвентарь") {
      await interaction.deferReply({ ephemeral: true });
      return showInventory(interaction, db);
    }

    if (commandName === "рынок") {
      await interaction.deferReply({ ephemeral: true });
      return showMarket(interaction, db);
    }

    if (commandName === "купить-рынок") {
      await interaction.deferReply({ ephemeral: true });
      const itemId = interaction.options.getInteger("id");
      return buyMarketItem(interaction, db, itemId);
    }

    if (commandName === "продать") {
      await interaction.deferReply({ ephemeral: true });
      return sellToMarket(interaction, db);
    }

    if (commandName === "xp-буфф") {
      await interaction.deferReply({ ephemeral: true });
      return buyXPBuff(interaction, db);
    }

    if (commandName === "перевести") {
      await interaction.deferReply({ ephemeral: true });
      return transferCoins(interaction, db);
    }

    if (commandName === "дать-монеты") {
      if (!member.permissions.has(PermissionFlagsBits.Administrator))
        return interaction.reply({ content: "❌ Только администраторы.", ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      return adminGiveCoins(interaction, db);
    }

    // ── Кланы ──────────────────────────────────────────────
    if (commandName === "клан") {
      const sub = interaction.options.getSubcommand();
      await interaction.deferReply({ ephemeral: true });

      if (sub === "создать")   return createClan(interaction, db);
      if (sub === "инфо")      return showClan(interaction, db);
      if (sub === "пригласить") return clanInvite(interaction, db);
      if (sub === "выгнать")   return clanKick(interaction, db);
      if (sub === "распустить") return disbandClan(interaction, db);
    }

    // ── Дуэль ──────────────────────────────────────────────
    if (commandName === "дуэль") {
      await interaction.deferReply({ ephemeral: false });
      const target = interaction.options.getUser("пользователь");
      const amount = interaction.options.getInteger("ставка");
      return duelChallenge(interaction, db, target, amount);
    }

    // ── Статистика ─────────────────────────────────────────
    if (commandName === "статистика-сервера") {
      await interaction.deferReply();
      return showServerStats(interaction, db);
    }

    if (commandName === "мод-контроль") {
      await interaction.deferReply({ ephemeral: true });
      return showModControl(interaction, db);
    }

    if (commandName === "aurex-статус") {
      await interaction.deferReply({ ephemeral: true });
      return showAurexStats(interaction, db);
    }
  });

  // ── Кнопки + Select + Modal роутер ───────────────────────
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.guild) return;

    const id = interaction.isButton() ? interaction.customId
             : interaction.isStringSelectMenu() ? interaction.customId
             : interaction.isModalSubmit() ? interaction.customId
             : null;
    if (!id) return;

    // ── Верификация — без defer ────────────────────────────
    if (id === "verify_btn") {
      return handleVerification(interaction, db);
    }

    // ── Модали — без defer ─────────────────────────────────
    if (interaction.isModalSubmit()) {
      // Роутим модали control-panel
      if (id.startsWith("ctrl_modal_")) {
        return controlPanel.handleModal(interaction);
      }
      return;
    }

    // ── Модалки ctrl_ai_* / ctrl_mod_* (показывают Modal — нельзя дефером) ──
    const noDefer = [
      "ctrl_ai_config","ctrl_ai_weights","ctrl_ai_prompt","ctrl_ai_limits",
      "ctrl_channels","ctrl_roles","ctrl_moderation","ctrl_tickets",
      "ctrl_gameserver","ctrl_rules_server","ctrl_rules_discord","ctrl_rules_ai",
      "ctrl_modal_music","ctrl_shop",
    ];
    if (noDefer.includes(id)) {
      if (interaction.isButton()) return controlPanel.handleButton(interaction);
    }

    // ── Select меню ────────────────────────────────────────
    if (interaction.isStringSelectMenu()) {
      return controlPanel.handleSelect(interaction);
    }

    // ── Кнопки — defer ────────────────────────────────────
    if (!interaction.isButton()) return;

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch { return; }

    try {
      // ── Control Panel кнопки ────────────────────────────
      if (id.startsWith("ctrl_")) {
        return controlPanel.handleButton(interaction);
      }

      // ── Экономика панель (pnl_*) ────────────────────────
      if (id === "pnl_profile")     return showProfile(interaction, db);
      if (id === "pnl_balance")     return showBalance(interaction, db);
      if (id === "pnl_daily")       return claimDaily(interaction, db);
      if (id === "pnl_work")        return doWork(interaction, db);
      if (id === "pnl_top")         return showTop(interaction, db, "xp");
      if (id === "pnl_case")        return openCase(interaction, db);
      if (id === "pnl_bgshop")      return showBgShop(interaction, db);
      if (id === "pnl_inventory")   return showInventory(interaction, db);
      if (id === "pnl_market")      return showMarket(interaction, db);
      if (id === "pnl_xpbuff")      return buyXPBuff(interaction, db);
      if (id === "pnl_clan_create") return createClan(interaction, db);
      if (id === "pnl_clan_info")   return showClan(interaction, db);
      if (id === "pnl_stats")       return showServerStats(interaction, db);
      if (id === "pnl_modcontrol")  return showModControl(interaction, db);

      // ── Мод-контроль тогглы ─────────────────────────────
      const { toggleSetting } = require("./panel-functions");
      if (id === "toggle_automod")    return toggleSetting(interaction, db, "auto_mod_enabled",    "Авто-модерация");
      if (id === "toggle_antiraid")   return toggleSetting(interaction, db, "anti_raid_enabled",   "Анти-рейд");
      if (id === "toggle_antispam")   return toggleSetting(interaction, db, "anti_spam_enabled",   "Анти-спам");
      if (id === "toggle_giffilter")  return toggleSetting(interaction, db, "gif_filter_enabled",  "GIF фильтр");
      if (id === "toggle_linkfilter") return toggleSetting(interaction, db, "link_filter_enabled", "Фильтр ссылок");
      if (id === "toggle_aimod")      return toggleSetting(interaction, db, "ai_mod_enabled",      "AI Модерация");
      if (id === "toggle_verify")     return toggleSetting(interaction, db, "verification_enabled","Верификация");
      if (id === "mod_stats_btn")     return showAurexStats(interaction, db);

      // ── Покупка фона ────────────────────────────────────
      if (id.startsWith("buybg_")) {
        return buyBackground(interaction, db, parseInt(id.replace("buybg_", "")));
      }

      // ── Дроп событие ────────────────────────────────────
      if (id.startsWith("event_claim_")) {
        const parts   = id.split("_");
        const eventId = parseInt(parts[2]);
        const reward  = parseInt(parts[3]);
        return handleEventClaim(interaction, db, eventId, reward);
      }

      // ── Дуэль принять/отклонить ─────────────────────────
      if (id.startsWith("duel_accept_")) {
        const parts = id.split("_");
        return handleDuelAccept(interaction, db, parts[2], parseInt(parts[3]));
      }
      if (id.startsWith("duel_decline_")) {
        return interaction.editReply({ content: "❌ Дуэль отклонена.", components: [] });
      }

    } catch (e) {
      console.error("[PanelCommands]", e.message);
      try { await interaction.editReply("❌ Ошибка. Попробуйте ещё раз."); } catch {}
    }
  });
}

// ─── ВСПОМОГАТЕЛЬНЫЕ КОМАНДЫ ──────────────────────────────────

// /продать — выставить предмет из инвентаря на рынок
async function sellToMarket(interaction, db) {
  const itemName = interaction.options.getString("предмет");
  const price    = interaction.options.getInteger("цена");
  const guildId  = interaction.guild.id;
  const userId   = interaction.user.id;

  const [rows] = await db.query(
    "SELECT id, amount FROM panel_inventory WHERE guild_id=? AND user_id=? AND item=?",
    [guildId, userId, itemName]
  );
  if (!rows.length)
    return interaction.editReply("❌ Этот предмет не найден в инвентаре.");

  await db.query("DELETE FROM panel_inventory WHERE id=?", [rows[0].id]);
  await db.query(
    "INSERT INTO panel_market (guild_id, seller, item, price, listed_at) VALUES (?,?,?,?,?)",
    [guildId, userId, itemName, price, Date.now()]
  );
  return interaction.editReply(`✅ **${itemName}** выставлен на рынок за **${price} монет**.`);
}

// /перевести — передача монет
async function transferCoins(interaction, db) {
  const { EmbedBuilder } = require("discord.js");
  const target = interaction.options.getUser("пользователь");
  const amount = interaction.options.getInteger("сумма");
  const guildId = interaction.guild.id;

  if (target.id === interaction.user.id)
    return interaction.editReply("❌ Нельзя переводить самому себе.");
  if (target.bot)
    return interaction.editReply("❌ Нельзя переводить ботам.");

  const [sender] = await db.query("SELECT coins FROM eco_users WHERE guild_id=? AND user_id=?",
    [guildId, interaction.user.id]);
  if (!sender.length || (sender[0].coins || 0) < amount)
    return interaction.editReply("❌ Недостаточно монет.");

  await db.query("UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?",
    [amount, guildId, interaction.user.id]);
  await db.query("INSERT INTO eco_users (guild_id,user_id,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=coins+?",
    [guildId, target.id, amount, amount]);

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("💸 Перевод выполнен")
    .setColor(0x00cc66)
    .setDescription(`**${amount} монет** отправлено <@${target.id}>`)
    .setTimestamp()
  ]});
}

// /дать-монеты (admin)
async function adminGiveCoins(interaction, db) {
  const target = interaction.options.getUser("пользователь");
  const amount = interaction.options.getInteger("сумма");
  const guildId = interaction.guild.id;

  await db.query(
    "INSERT INTO eco_users (guild_id,user_id,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=coins+?",
    [guildId, target.id, amount, amount]
  );
  return interaction.editReply(`✅ <@${target.id}> получил **${amount}** монет.`);
}

// /клан пригласить
async function clanInvite(interaction, db) {
  const target  = interaction.options.getUser("пользователь");
  const guildId = interaction.guild.id;

  const [ownerClan] = await db.query(
    "SELECT id, name FROM panel_clans WHERE guild_id=? AND owner=?", [guildId, interaction.user.id]
  );
  if (!ownerClan.length) return interaction.editReply("❌ У тебя нет клана или ты не являешься владельцем.");

  const [alreadyIn] = await db.query(
    "SELECT clan_id FROM panel_clan_members WHERE guild_id=? AND user_id=?", [guildId, target.id]
  );
  if (alreadyIn.length) return interaction.editReply("❌ Этот пользователь уже состоит в клане.");

  await db.query(
    "INSERT INTO panel_clan_members (guild_id, clan_id, user_id, rank) VALUES (?,?,?,'member')",
    [guildId, ownerClan[0].id, target.id]
  );

  // Выдать роль клана если есть
  const [clanRow] = await db.query("SELECT role_id FROM panel_clans WHERE id=?", [ownerClan[0].id]);
  if (clanRow[0]?.role_id) {
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.roles.add(clanRow[0].role_id);
    } catch {}
  }

  return interaction.editReply(`✅ <@${target.id}> добавлен в клан **${ownerClan[0].name}**.`);
}

// /клан выгнать
async function clanKick(interaction, db) {
  const target  = interaction.options.getUser("пользователь");
  const guildId = interaction.guild.id;

  const [ownerClan] = await db.query(
    "SELECT id, name, role_id FROM panel_clans WHERE guild_id=? AND owner=?", [guildId, interaction.user.id]
  );
  if (!ownerClan.length) return interaction.editReply("❌ Ты не владелец клана.");
  if (target.id === interaction.user.id) return interaction.editReply("❌ Нельзя выгнать самого себя.");

  await db.query(
    "DELETE FROM panel_clan_members WHERE guild_id=? AND clan_id=? AND user_id=?",
    [guildId, ownerClan[0].id, target.id]
  );

  if (ownerClan[0].role_id) {
    try {
      const member = await interaction.guild.members.fetch(target.id);
      await member.roles.remove(ownerClan[0].role_id);
    } catch {}
  }

  return interaction.editReply(`✅ <@${target.id}> выгнан из клана.`);
}

// /клан распустить
async function disbandClan(interaction, db) {
  const guildId = interaction.guild.id;

  const [ownerClan] = await db.query(
    "SELECT id, name, role_id FROM panel_clans WHERE guild_id=? AND owner=?", [guildId, interaction.user.id]
  );
  if (!ownerClan.length) return interaction.editReply("❌ У тебя нет клана.");

  await db.query("DELETE FROM panel_clan_members WHERE clan_id=?", [ownerClan[0].id]);
  await db.query("DELETE FROM panel_clans WHERE id=?", [ownerClan[0].id]);

  if (ownerClan[0].role_id) {
    try {
      const role = interaction.guild.roles.cache.get(ownerClan[0].role_id);
      if (role) await role.delete("Клан распущен");
    } catch {}
  }

  return interaction.editReply(`🧬 Клан **${ownerClan[0].name}** распущен.`);
}

// Обработка event_claim (дроп монет)
async function handleEventClaim(interaction, db, eventId, reward) {
  const [[ev]] = await db.query("SELECT claimed_by FROM panel_events WHERE id=?", [eventId]);
  if (!ev)          return interaction.editReply("❌ Событие не найдено.");
  if (ev.claimed_by) return interaction.editReply("❌ Монеты уже забрал кто-то другой!");

  const [res] = await db.query(
    "UPDATE panel_events SET claimed_by=? WHERE id=? AND claimed_by IS NULL",
    [interaction.user.id, eventId]
  );
  if (!res.affectedRows)
    return interaction.editReply("❌ Не успел — монеты уже забрали!");

  await db.query(
    "INSERT INTO eco_users (guild_id,user_id,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=coins+?",
    [interaction.guild.id, interaction.user.id, reward, reward]
  );
  return interaction.editReply(`🎉 Ты успел первым! **+${reward} монет** добавлено!`);
}

// ─── ЭКСПОРТ ─────────────────────────────────────────────────
module.exports = {
  PANEL_COMMANDS,
  registerPanelCommands,
  attachPanelHandlers,
};
