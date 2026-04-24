// modules/tickets.js — Полная система тикетов AUREX-9

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  ChannelType, PermissionFlagsBits
} = require("discord.js");
const { getGuildSetting, setGuildSetting } = require("./settings");

const PRIORITY_COLORS = {
  low:    0x57f287,
  normal: 0x3399ff,
  high:   0xff9900,
  vip:    0xff3300,
  urgent: 0xff0000
};

const PRIORITY_LABELS = {
  low:    "🟢 Низкий",
  normal: "🔵 Обычный",
  high:   "🟠 Высокий",
  vip:    "🔴 VIP",
  urgent: "🚨 Срочный"
};

const STATUS_LABELS = {
  open:     "🟢 Открыт",
  claimed:  "🟡 Взят в работу",
  waiting:  "🟠 Ожидает ответа",
  resolved: "🔵 Решён",
  closed:   "🔴 Закрыт"
};

// Дефолтные категории тикетов
const DEFAULT_CATEGORIES = [
  { name: "Жалоба на игрока",     emoji: "⚔️",  priority: "normal", description: "Нарушение правил другим игроком" },
  { name: "Жалоба на модератора", emoji: "🛡️", priority: "high",   description: "Некорректные действия модератора" },
  { name: "Апелляция бана",       emoji: "⚖️",  priority: "high",   description: "Оспорить выданный бан или мут" },
  { name: "Вопрос / Помощь",      emoji: "❓",  priority: "low",    description: "Любой вопрос или помощь" },
  { name: "Покупка / Донат",       emoji: "💎",  priority: "vip",    description: "Вопросы по донату и привилегиям" },
  { name: "Сообщить об ошибке",   emoji: "🐛",  priority: "normal", description: "Баг или техническая проблема" }
];

class TicketManager {
  constructor(client, db, auditLogger) {
    this.client      = client;
    this.db          = db;
    this.auditLogger = auditLogger;
    this.modQueues   = new Map(); // guildId -> [modIds]
    this.queueIndex  = new Map(); // guildId -> index
  }

  // ── РАЗВОРАЧИВАНИЕ ПАНЕЛИ ТИКЕТОВ ─────────────
  async deployPanel(guildId) {
    const channelId = await getGuildSetting(this.db, guildId, "ticket_panel_channel");
    if (!channelId) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return;

    // Убираем старую панель
    const msgs = await channel.messages.fetch({ limit: 10 }).catch(() => null);
    const old  = msgs?.find(m => m.author.id === this.client.user.id && m.embeds.length > 0);
    if (old) await old.delete().catch(() => {});

    await this.sendPanel(channel, guildId);
  }

  async deployPanelCommand(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content: "❌ Только администраторы.", flags: 64 });

    await setGuildSetting(this.db, interaction.guild.id, "ticket_panel_channel", interaction.channel.id);
    await this.sendPanel(interaction.channel, interaction.guild.id);
    return interaction.reply({ content: "✅ Панель тикетов развёрнута в этом канале.", flags: 64 });
  }

  async sendPanel(channel, guildId) {
    const categories = await this.getCategories(guildId);

    const embed = new EmbedBuilder()
      .setTitle("🎫 Служба поддержки AUREX-9")
      .setColor(0x3399ff)
      .setDescription(
        "Добро пожаловать в систему поддержки!\n\n" +
        "**Как создать тикет:**\n" +
        "1️⃣ Выберите категорию из меню ниже\n" +
        "2️⃣ Заполните форму обращения\n" +
        "3️⃣ Дождитесь ответа модератора\n\n" +
        "**Доступные категории:**\n" +
        categories.map(c => `${c.emoji} **${c.name}** — ${c.description || "—"}`).join("\n")
      )
      .setFooter({ text: "AUREX-9 • Служба поддержки" })
      .setTimestamp();

    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticket_category_select")
      .setPlaceholder("📂 Выберите категорию тикета...")
      .setMinValues(1)
      .setMaxValues(1)
      .addOptions(categories.map(c => ({
        label:       c.name,
        value:       String(c.id || c.name),
        description: (c.description || "").slice(0, 100),
        emoji:       c.emoji
      })));

    await channel.send({
      embeds:     [embed],
      components: [new ActionRowBuilder().addComponents(menu)]
    });
  }

  // ── КАТЕГОРИИ ─────────────────────────────────
  async getCategories(guildId) {
    const [rows] = await this.db.query("SELECT * FROM ticket_categories WHERE guild_id=? ORDER BY sort_order ASC", [guildId]);
    if (rows.length) return rows;

    // Создать дефолтные категории
    for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
      const c = DEFAULT_CATEGORIES[i];
      await this.db.query(
        "INSERT IGNORE INTO ticket_categories (guild_id, name, emoji, description, priority, sort_order) VALUES (?,?,?,?,?,?)",
        [guildId, c.name, c.emoji, c.description, c.priority, i]
      );
    }
    const [newRows] = await this.db.query("SELECT * FROM ticket_categories WHERE guild_id=? ORDER BY sort_order ASC", [guildId]);
    return newRows;
  }

  // ── ВЫБОР КАТЕГОРИИ ───────────────────────────
  async handleCategorySelect(interaction) {
    const guildId    = interaction.guild.id;
    const userId     = interaction.user.id;
    const categoryId = interaction.values[0];

    // Проверить: нет ли уже открытого тикета
    const [existing] = await this.db.query(
      "SELECT * FROM tickets WHERE guild_id=? AND user_id=? AND status NOT IN ('closed','resolved') LIMIT 1",
      [guildId, userId]
    );
    if (existing.length) {
      return interaction.reply({
        content: `❌ У вас уже есть открытый тикет: <#${existing[0].channel_id}>\nПожалуйста, закройте его перед созданием нового.`,
        flags: 64
      });
    }

    const categories = await this.getCategories(guildId);
    const category   = categories.find(c => String(c.id || c.name) === categoryId);
    if (!category) return interaction.reply({ content: "❌ Категория не найдена.", flags: 64 });

    // Модальное окно
    const modal = new ModalBuilder()
      .setCustomId(`ticket_modal_${categoryId}`)
      .setTitle(`${category.emoji} ${category.name}`);

    const subjectInput = new TextInputBuilder()
      .setCustomId("ticket_subject")
      .setLabel("Тема обращения")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("Кратко опишите суть проблемы...")
      .setMinLength(5)
      .setMaxLength(100)
      .setRequired(true);

    const detailInput = new TextInputBuilder()
      .setCustomId("ticket_detail")
      .setLabel("Подробное описание")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Опишите ситуацию подробно: что произошло, когда, ники участников...")
      .setMinLength(20)
      .setMaxLength(1000)
      .setRequired(true);

    const evidenceInput = new TextInputBuilder()
      .setCustomId("ticket_evidence")
      .setLabel("Доказательства (ссылки на скриншоты)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("Ссылки на скриншоты, записи и т.д. (необязательно)")
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(subjectInput),
      new ActionRowBuilder().addComponents(detailInput),
      new ActionRowBuilder().addComponents(evidenceInput)
    );

    await interaction.showModal(modal);
  }

  // ── СОЗДАНИЕ ТИКЕТА (МОДАЛЬНОЕ ОКНО) ─────────
  async handleModal(interaction) {
    const guildId    = interaction.guild.id;
    const userId     = interaction.user.id;
    const categoryId = interaction.customId.replace("ticket_modal_", "");

    const subject  = interaction.fields.getTextInputValue("ticket_subject");
    const detail   = interaction.fields.getTextInputValue("ticket_detail");
    const evidence = interaction.fields.getTextInputValue("ticket_evidence").catch?.() || "";

    const categories = await this.getCategories(guildId);
    const category   = categories.find(c => String(c.id || c.name) === categoryId);
    if (!category) return interaction.reply({ content: "❌ Категория не найдена.", flags: 64 });

    await interaction.deferReply({ flags: 64 });

    try {
      const ticketId = `A9-${Date.now().toString(36).toUpperCase()}`;
      const modId    = category.role_id || await this.getNextMod(guildId);
      const isRole   = !!category.role_id;

      // Получить категорию каналов тикетов
      const categoryChannelId = await getGuildSetting(this.db, guildId, "ticket_category_channel");

      // Создать канал
      const ticketChannel = await interaction.guild.channels.create({
        name:   `тикет-${ticketId.toLowerCase()}`,
        type:   ChannelType.GuildText,
        parent: categoryChannelId || null,
        topic:  `🎫 ${ticketId} | ${subject} | Пользователь: ${interaction.user.tag}`,
        permissionOverwrites: [
          { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
          ...(modId ? [{ id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages] }] : [])
        ]
      });

      // Добавить admin ролям тоже доступ
      const adminRoles = JSON.parse(await getGuildSetting(this.db, guildId, "admin_roles", "[]"));
      for (const roleId of adminRoles) {
        await ticketChannel.permissionOverwrites.create(roleId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageMessages: true
        }).catch(() => {});
      }

      // Сохранить в БД
      await this.db.query(
        "INSERT INTO tickets (ticket_id,guild_id,channel_id,user_id,mod_id,status,category,sub_category,priority,subject,reason,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?,?,?,?,?,?)",
        [ticketId, guildId, ticketChannel.id, userId, modId, category.name, categoryId, category.priority, subject, detail, Date.now(), Date.now()]
      );

      await this.db.query(
        "INSERT INTO ticket_history (ticket_id,guild_id,action,author_id,created_at) VALUES (?,?,?,?,?)",
        [ticketId, guildId, "create", userId, Date.now()]
      );

      // Отправить сообщение в тикет-канал
      const responsible = isRole ? `<@&${modId}>` : (modId ? `<@${modId}>` : "@команда");

      const embed = new EmbedBuilder()
        .setTitle(`${category.emoji} ${ticketId} — ${subject}`)
        .setColor(PRIORITY_COLORS[category.priority] || 0x3399ff)
        .setDescription(
          `> ${detail}\n` +
          (evidence ? `\n**📎 Доказательства:** ${evidence}` : "")
        )
        .addFields(
          { name: "👤 Пользователь",  value: `<@${userId}>`, inline: true },
          { name: "📂 Категория",     value: `${category.emoji} ${category.name}`, inline: true },
          { name: "🏷️ Приоритет",    value: PRIORITY_LABELS[category.priority] || "🔵 Обычный", inline: true },
          { name: "📊 Статус",        value: STATUS_LABELS.open, inline: true },
          { name: "👮 Ответственный", value: responsible, inline: true },
          { name: "🆔 ID тикета",     value: `\`${ticketId}\``, inline: true }
        )
        .setFooter({ text: `AUREX-9 • Создан: ${new Date().toLocaleString("ru-RU")}` });

      // Кнопки пользователя
      const userRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Закрыть тикет").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ticket_rate").setLabel("⭐ Оценить").setStyle(ButtonStyle.Secondary)
      );

      // Кнопки сотрудника
      const staffRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ticket_claim").setLabel("✋ Взять в работу").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("ticket_transfer").setLabel("🔄 Передать").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ticket_close_reason").setLabel("🔒 Закрыть с причиной").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("ticket_priority").setLabel("⚡ Приоритет").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ticket_transcript").setLabel("📋 Транскрипт").setStyle(ButtonStyle.Secondary)
      );

      await ticketChannel.send({
        content: `🎫 ${responsible}, поступил новый тикет от <@${userId}>!`,
        embeds: [embed],
        components: [userRow, staffRow]
      });

      // Пинговать пользователя в начале
      const welcomeMsg = await ticketChannel.send({
        content: `Привет, <@${userId}>! 👋\nТвой тикет **${ticketId}** создан.\n\nПожалуйста, подожди — сотрудник скоро ответит.`
      });
      setTimeout(() => welcomeMsg.delete().catch(() => {}), 10000);

      // Лог тикета
      await this.auditLogger.guildLog(guildId, "🎫 Тикет создан", [
        { name: "ID",           value: ticketId },
        { name: "Пользователь", value: `<@${userId}>` },
        { name: "Категория",    value: category.name },
        { name: "Тема",         value: subject },
        { name: "Канал",        value: `<#${ticketChannel.id}>` }
      ], 0x00cc66);

      await interaction.editReply({ content: `✅ Тикет создан: ${ticketChannel}` });

    } catch (e) {
      console.error("[ticket create]", e);
      await interaction.editReply({ content: "❌ Ошибка при создании тикета. Обратитесь к администратору." });
    }
  }

  // ── СОЗДАНИЕ ИЗ КОМАНДЫ ───────────────────────
  async createFromCommand(interaction) {
    const categories = await this.getCategories(interaction.guild.id);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ticket_category_select")
      .setPlaceholder("Выберите категорию...")
      .addOptions(categories.map(c => ({
        label: c.name, value: String(c.id || c.name),
        description: (c.description || "").slice(0, 100), emoji: c.emoji
      })));
    return interaction.reply({
      content: "📂 Выберите категорию тикета:",
      components: [new ActionRowBuilder().addComponents(menu)],
      flags: 64
    });
  }

  // ── ОБРАБОТКА КНОПОК ─────────────────────────
  async handleButton(interaction) {
    const { customId, guild, member, user, channel } = interaction;
    const guildId = guild.id;

    // ✅ Defer immediately — db.query takes time and interaction times out
    const _showsModal = customId === "ticket_close_reason";
    const _doesUpdate = ["ticket_close_cancel", "ticket_close_confirm"].includes(customId) || customId.startsWith("ticket_rate_");
    if (!_showsModal && !_doesUpdate) await interaction.deferReply({ flags: 64 }).catch(() => {});

    const [rows] = await this.db.query(
      "SELECT * FROM tickets WHERE channel_id=? AND guild_id=?",
      [channel.id, guildId]
    );
    const ticket = rows[0];

    if (!ticket && !["ticket_close","ticket_close_reason","ticket_claim","ticket_transfer","ticket_priority","ticket_transcript","ticket_rate"].includes(customId)) {
      return interaction.editReply({ content: "❌ Тикет не найден." });
    }

    switch (customId) {

      case "ticket_claim": {
        const isStaffClaim = await this.isStaff(member, guildId);
        if (!isStaffClaim) return interaction.editReply({ content: "❌ Только сотрудники." });
        if (!ticket) return interaction.editReply({ content: "❌ Тикет не найден." });
        if (ticket.status !== "open")
          return interaction.editReply({ content: "❌ Тикет уже взят в работу." });

        await this.db.query(
          "UPDATE tickets SET status='claimed', claimed_by=?, mod_id=?, updated_at=? WHERE ticket_id=?",
          [user.id, user.id, Date.now(), ticket.ticket_id]
        );
        await this.db.query("INSERT INTO ticket_history (ticket_id,guild_id,action,author_id,created_at) VALUES (?,?,?,?,?)", [ticket.ticket_id, guildId, "claim", user.id, Date.now()]);

        const claimEmbed = new EmbedBuilder()
          .setColor(0xffcc00)
          .setTitle("✋ Тикет взят в работу")
          .setDescription(`Сотрудник <@${user.id}> взял тикет в работу.\n\nПожалуйста, ожидайте ответа!`)
          .setTimestamp();

        await channel.send({ embeds: [claimEmbed] });

        // Обновить статистику
        await this.updateModStats(guildId, user.id, ticket.created_at);
        return interaction.editReply({ content: `✅ Вы взяли тикет ${ticket.ticket_id} в работу.` });
      }

      case "ticket_close": {
        const canClose = interaction.user.id === ticket?.user_id || await this.isStaff(member, guildId);
        if (!canClose) return interaction.editReply({ content: "❌ Нет прав закрыть тикет." });

        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("ticket_close_confirm").setLabel("✅ Да, закрыть").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("ticket_close_cancel").setLabel("❌ Отмена").setStyle(ButtonStyle.Secondary)
        );
        return interaction.editReply({
          content: "⚠️ Вы уверены, что хотите закрыть тикет?",
          components: [confirmRow],
          flags: 64
        });
      }

      case "ticket_close_confirm": {
        if (!ticket) return interaction.editReply({ content: "❌ Тикет не найден." });
        await interaction.deferUpdate();
        await this.closeTicket(channel, ticket, "Закрыт пользователем", user.id, guildId);
        return;
      }

      case "ticket_close_cancel":
        return interaction.update({ content: "❌ Закрытие отменено.", components: [] });

      case "ticket_close_reason": {
        const isStaffCloseReason = await this.isStaff(member, guildId);
        if (!isStaffCloseReason) return interaction.editReply({ content: "❌ Только сотрудники." });
        const modal = new ModalBuilder()
          .setCustomId("ticket_modal_close_reason")
          .setTitle("🔒 Закрыть тикет");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId("close_reason")
              .setLabel("Причина закрытия")
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder("Опишите итог рассмотрения тикета...")
              .setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      case "ticket_transfer": {
        const isStaffTransfer = await this.isStaff(member, guildId);
        if (!isStaffTransfer) return interaction.editReply({ content: "❌ Только сотрудники." });

        const nextMod = await this.getNextMod(guildId, user.id);
        if (!nextMod)
          return interaction.editReply({ content: "❌ Нет доступных модераторов." });

        await this.transferTicket(channel, ticket, nextMod, false, guildId);
        return interaction.editReply({ content: `✅ Тикет передан <@${nextMod}>` });
      }

      case "ticket_priority": {
        const isStaffPriority = await this.isStaff(member, guildId);
        if (!isStaffPriority) return interaction.editReply({ content: "❌ Только сотрудники." });

        const menu = new StringSelectMenuBuilder()
          .setCustomId("ticket_set_priority")
          .setPlaceholder("Выберите приоритет...")
          .addOptions(
            { label: "Низкий",   value: "low",    emoji: "🟢" },
            { label: "Обычный",  value: "normal",  emoji: "🔵" },
            { label: "Высокий",  value: "high",    emoji: "🟠" },
            { label: "VIP",      value: "vip",     emoji: "🔴" },
            { label: "Срочный",  value: "urgent",  emoji: "🚨" }
          );
        return interaction.reply({
          content: "⚡ Выберите приоритет тикета:",
          components: [new ActionRowBuilder().addComponents(menu)],
          flags: 64
        });
      }

      case "ticket_transcript": {
        const isStaffTranscript = await this.isStaff(member, guildId);
        if (!isStaffTranscript) return interaction.editReply({ content: "❌ Только сотрудники." });
        if (!ticket) return interaction.editReply({ content: "❌ Тикет не найден." });
        const transcript = await this.generateTranscript(channel, ticket);
        return interaction.editReply({
          content: `📋 Транскрипт тикета **${ticket.ticket_id}**:\n\`\`\`\n${transcript.slice(0, 1900)}\n\`\`\``
        });
      }

      case "ticket_rate": {
        if (!ticket) return interaction.editReply({ content: "❌ Тикет не найден." });
        if (interaction.user.id !== ticket.user_id)
          return interaction.editReply({ content: "❌ Только автор тикета может оценить работу." });

        const rateRow = new ActionRowBuilder().addComponents(
          ...[1, 2, 3, 4, 5].map(n =>
            new ButtonBuilder()
              .setCustomId(`ticket_rate_${n}`)
              .setLabel("⭐".repeat(n))
              .setStyle(n >= 4 ? ButtonStyle.Success : n === 3 ? ButtonStyle.Primary : ButtonStyle.Danger)
          )
        );
        return interaction.editReply({ content: "⭐ Оцените работу сотрудника:", components: [rateRow] });
      }
    }

    // Оценка тикета
    if (customId.startsWith("ticket_rate_")) {
      const rating = parseInt(customId.split("_")[2]);
      if (ticket) {
        await this.db.query("UPDATE tickets SET rating=? WHERE ticket_id=?", [rating, ticket.ticket_id]);
        if (ticket.mod_id) {
          await this.db.query(
            "UPDATE mod_stats SET quality_score = quality_score + ? WHERE mod_id=? AND guild_id=?",
            [rating * 2, ticket.mod_id, guildId]
          );
        }
      }
      return interaction.update({ content: `✅ Спасибо за оценку! ${"⭐".repeat(rating)}`, components: [] });
    }
  }

 // ── МОДАЛЬНЫЕ ОКНА (ОБРАБОТКА) ────────────────
async handleModal(interaction) {
  const { customId } = interaction;

  // 🔒 Закрытие тикета с причиной
  if (customId === "ticket_modal_close_reason") {
    return this.handleCloseReasonModal(interaction);
  }

  // 🎫 Создание тикета
  if (customId.startsWith("ticket_modal_")) {
    return this.handleTicketCreate(interaction);
  }
}

// ── СОЗДАНИЕ ТИКЕТА ───────────────────────────
async handleTicketCreate(interaction) {
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const categoryId = interaction.customId.replace("ticket_modal_", "");

  const subject = interaction.fields.getTextInputValue("ticket_subject") || "Без темы";
  const detail  = interaction.fields.getTextInputValue("ticket_detail") || "Описание не указано";

  let evidence = "";
  try {
    evidence = interaction.fields.getTextInputValue("ticket_evidence");
  } catch {}

  const categories = await this.getCategories(guildId);
  const category = categories.find(c => String(c.id || c.name) === categoryId);

  if (!category) {
    return interaction.reply({ content: "❌ Категория не найдена.", flags: 64 });
  }

  await interaction.deferReply({ flags: 64 });

  try {
    const ticketId = `A9-${Date.now().toString(36).toUpperCase()}`;
    const modId    = category.role_id || await this.getNextMod(guildId);
    const isRole   = !!category.role_id;

    const categoryChannelId = await getGuildSetting(this.db, guildId, "ticket_category_channel");

    const ticketChannel = await interaction.guild.channels.create({
      name: `тикет-${ticketId.toLowerCase()}`,
      type: ChannelType.GuildText,
      parent: categoryChannelId || null,
      topic: `🎫 ${ticketId} | ${subject} | ${interaction.user.tag}`,
      permissionOverwrites: [
        { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: userId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ...(modId ? [{ id: modId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }] : [])
      ]
    });

    // 💾 БД
    await this.db.query(
      "INSERT INTO tickets (ticket_id,guild_id,channel_id,user_id,mod_id,status,category,priority,subject,reason,created_at,updated_at) VALUES (?,?,?,?,?,'open',?,?,?,?,?,?)",
      [ticketId, guildId, ticketChannel.id, userId, modId, category.name, category.priority, subject, detail, Date.now(), Date.now()]
    );

    // 👮 ответственный
    const responsible = isRole ? `<@&${modId}>` : (modId ? `<@${modId}>` : "@команда");

    const safeDetail = detail?.trim() ? detail : "Описание не указано";

    const embed = new EmbedBuilder()
      .setTitle(`${category.emoji} ${ticketId} — ${subject}`)
      .setColor(PRIORITY_COLORS[category.priority] || 0x3399ff)
      .setDescription(
        `> ${safeDetail}` +
        (evidence ? `\n\n**📎 Доказательства:**\n${evidence}` : "")
      )
      .addFields(
        { name: "👤 Пользователь",  value: `<@${userId}>`, inline: true },
        { name: "📂 Категория",     value: `${category.emoji} ${category.name}`, inline: true },
        { name: "🏷️ Приоритет",    value: PRIORITY_LABELS[category.priority] || "🔵 Обычный", inline: true },
        { name: "📊 Статус",        value: STATUS_LABELS.open, inline: true },
        { name: "👮 Ответственный", value: responsible, inline: true },
        { name: "🆔 ID тикета",     value: `\`${ticketId}\``, inline: true }
      )
      .setFooter({ text: `AUREX-9 • ${new Date().toLocaleString("ru-RU")}` })
      .setTimestamp();

    const userRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_close").setLabel("🔒 Закрыть").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("ticket_rate").setLabel("⭐ Оценить").setStyle(ButtonStyle.Secondary)
    );

    const staffRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ticket_claim").setLabel("✋ Взять").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("ticket_transfer").setLabel("🔄 Передать").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ticket_close_reason").setLabel("🔒 Закрыть с причиной").setStyle(ButtonStyle.Danger)
    );

    await ticketChannel.send({
      content: `🎫 ${responsible}, новый тикет от <@${userId}>`,
      embeds: [embed],
      components: [userRow, staffRow]
    });

    await interaction.editReply({
      content: `✅ Тикет создан: ${ticketChannel}`
    });

  } catch (e) {
    console.error("[ticket create]", e);
    await interaction.editReply({
      content: "❌ Ошибка при создании тикета."
    });
  }
}

// ── ЗАКРЫТИЕ С ПРИЧИНОЙ ───────────────────────
async handleCloseReasonModal(interaction) {
  const guildId = interaction.guild.id;
  const userId  = interaction.user.id;
  const channel = interaction.channel;

  const reason = interaction.fields.getTextInputValue("close_reason");

  const [rows] = await this.db.query(
    "SELECT * FROM tickets WHERE channel_id=? AND guild_id=?",
    [channel.id, guildId]
  );

  const ticket = rows[0];

  if (!ticket) {
    return interaction.reply({ content: "❌ Тикет не найден.", flags: 64 });
  }

  await interaction.deferUpdate();
  await this.closeTicket(channel, ticket, reason, userId, guildId);



    // Создание тикета через модал
    return await this.handleModalCreate(interaction);
  }

  async handleModalCreate(interaction) {
    // Уже обработано в index.js через handleModal
    return this.handleModal(interaction);
  }

  // ── ЗАКРЫТИЕ ТИКЕТА ───────────────────────────
  async closeTicket(channel, ticket, reason, closedBy, guildId) {
    try {
      await this.db.query(
        "UPDATE tickets SET status='closed', closed_reason=?, closed_by=?, closed_at=?, updated_at=? WHERE ticket_id=?",
        [reason, closedBy, Date.now(), Date.now(), ticket.ticket_id]
      );
      await this.db.query(
        "INSERT INTO ticket_history (ticket_id,guild_id,action,author_id,reason,created_at) VALUES (?,?,?,?,?,?)",
        [ticket.ticket_id, guildId, "close", closedBy, reason, Date.now()]
      );

      // Транскрипт
      const transcript = await this.generateTranscript(channel, ticket);
      const logChannelId = await getGuildSetting(this.db, guildId, "ticket_log_channel");
      if (logChannelId) {
        const logCh = await this.client.channels.fetch(logChannelId).catch(() => null);
        if (logCh?.isTextBased()) {
          await logCh.send({
            embeds: [new EmbedBuilder()
              .setTitle(`🔒 Тикет закрыт — ${ticket.ticket_id}`)
              .setColor(0xff3300)
              .addFields(
                { name: "Пользователь", value: `<@${ticket.user_id}>` },
                { name: "Причина закрытия", value: reason },
                { name: "Закрыл", value: `<@${closedBy}>` },
                { name: "Категория", value: ticket.category },
                { name: "Длительность", value: this.formatDuration(Date.now() - ticket.created_at) },
                { name: "Оценка", value: ticket.rating ? "⭐".repeat(ticket.rating) : "Не оценено" }
              )
              .setTimestamp()
            ]
          });

          if (transcript.length > 50) {
            const chunks = this.chunkString(transcript, 1900);
            await logCh.send(`📋 **Транскрипт тикета ${ticket.ticket_id}:**`);
            for (const chunk of chunks.slice(0, 3)) {
              await logCh.send({ content: "```\n" + chunk + "\n```" }).catch(() => {});
            }
          }
        }
      }

      // Закрывающее сообщение
      const closeEmbed = new EmbedBuilder()
        .setTitle("🔒 Тикет закрыт")
        .setColor(0xff3300)
        .addFields(
          { name: "Причина", value: reason },
          { name: "Закрыл", value: `<@${closedBy}>` }
        )
        .setDescription("Канал будет удалён через 15 секунд.\n\nЕсли у вас остались вопросы — создайте новый тикет.")
        .setTimestamp();

      await channel.send({ embeds: [closeEmbed] }).catch(() => {});

      // Запретить писать
      await channel.permissionOverwrites.edit(
        channel.guild.roles.everyone, { SendMessages: false, ViewChannel: false }
      ).catch(() => {});

      // Дать пользователю увидеть закрытие
      if (ticket.user_id) {
        await channel.permissionOverwrites.edit(ticket.user_id, { SendMessages: false, ViewChannel: true }).catch(() => {});
      }

      await this.auditLogger.guildLog(guildId, "🔒 Тикет закрыт", [
        { name: "ID",        value: ticket.ticket_id },
        { name: "Причина",   value: reason },
        { name: "Закрыл",    value: `<@${closedBy}>` }
      ], 0xff3300);

      setTimeout(() => channel.delete("Тикет закрыт").catch(() => {}), 15000);
    } catch (e) {
      console.error("[closeTicket]", e.message);
    }
  }

  // ── ПЕРЕДАЧА ТИКЕТА ───────────────────────────
  async transferTicket(channel, ticket, newModId, isRole, guildId) {
    await this.db.query("UPDATE tickets SET mod_id=?, updated_at=? WHERE ticket_id=?", [newModId, Date.now(), ticket.ticket_id]);
    await this.db.query("INSERT INTO ticket_history (ticket_id,guild_id,action,author_id,created_at) VALUES (?,?,?,?,?)", [ticket.ticket_id, guildId, "transfer", newModId, Date.now()]);

    const overwrites = [
      { id: channel.guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
      { id: ticket.user_id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: newModId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] }
    ];
    await channel.permissionOverwrites.set(overwrites).catch(() => {});

    const display = isRole ? `<@&${newModId}>` : `<@${newModId}>`;
    await channel.send({
      embeds: [new EmbedBuilder()
        .setColor(0x3399ff)
        .setTitle("🔄 Тикет передан")
        .setDescription(`Тикет передан ${display}`)
        .setTimestamp()
      ]
    });
  }

  // ── СПИСОК ТИКЕТОВ ────────────────────────────
  async listTickets(interaction) {
    const guildId = interaction.guild.id;
    const isStaff = await this.isStaff(interaction.member, guildId);
    let query, params;

    if (isStaff) {
      query  = "SELECT * FROM tickets WHERE guild_id=? AND status NOT IN ('closed') ORDER BY created_at DESC LIMIT 20";
      params = [guildId];
    } else {
      query  = "SELECT * FROM tickets WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 10";
      params = [guildId, interaction.user.id];
    }

    const [tickets] = await this.db.query(query, params);
    if (!tickets.length) return interaction.reply({ content: "ℹ️ Нет тикетов.", flags: 64 });

    const lines = tickets.map(t =>
      `\`${t.ticket_id}\` ${STATUS_LABELS[t.status] || t.status} — **${t.subject || t.category}** <#${t.channel_id}>`
    ).join("\n");

    return interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`🎫 ${isStaff ? "Все тикеты сервера" : "Ваши тикеты"}`)
        .setColor(0x3399ff)
        .setDescription(lines)
        .setTimestamp()
      ],
      flags: 64
    });
  }

  // ── ДОБАВИТЬ ПОЛЬЗОВАТЕЛЯ В ТИКЕТ ─────────────
  async addUser(interaction) {
    const user    = interaction.options.getUser("пользователь");
    const channel = interaction.channel;
    await channel.permissionOverwrites.create(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true
    });
    return interaction.reply({ content: `✅ ${user.tag} добавлен в тикет.`, flags: 64 });
  }

  // ── КОМАНДА ЗАКРЫТЬ ───────────────────────────
  async closeFromCommand(interaction) {
    const [rows] = await this.db.query("SELECT * FROM tickets WHERE channel_id=? AND guild_id=?", [interaction.channel.id, interaction.guild.id]);
    const ticket = rows[0];
    if (!ticket) return interaction.reply({ content: "❌ Этот канал не является тикетом.", flags: 64 });
    if (interaction.user.id !== ticket.user_id && !await this.isStaff(interaction.member, interaction.guild.id))
      return interaction.reply({ content: "❌ Нет прав.", flags: 64 });
    const reason = interaction.options.getString("причина") || "Закрыт командой";
    await interaction.deferReply({ flags: 64 });
    await this.closeTicket(interaction.channel, ticket, reason, interaction.user.id, interaction.guild.id);
    return interaction.editReply({ content: "✅ Тикет закрыт." });
  }

  // ── ВСПОМОГАТЕЛЬНЫЕ ───────────────────────────
  async isStaff(member, guildId) {
    if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
    const modRoles   = JSON.parse(await getGuildSetting(this.db, guildId, "mod_roles", "[]"));
    const adminRoles = JSON.parse(await getGuildSetting(this.db, guildId, "admin_roles", "[]"));
    return [...modRoles, ...adminRoles].some(r => member.roles.cache.has(r));
  }

  async getNextMod(guildId, excludeId = null) {
    if (!this.modQueues.has(guildId)) {
      try {
        const guild   = await this.client.guilds.fetch(guildId);
        const members = await guild.members.fetch();
        const modRoles = JSON.parse(await getGuildSetting(this.db, guildId, "mod_roles", "[]"));
        const mods = members.filter(m => !m.user.bot && modRoles.some(r => m.roles.cache.has(r))).map(m => m.id);
        this.modQueues.set(guildId, mods);
        this.queueIndex.set(guildId, 0);
      } catch (e) { return null; }
    }

    const queue = this.modQueues.get(guildId) || [];
    if (!queue.length) return null;

    const filtered = queue.filter(id => id !== excludeId);
    if (!filtered.length) return queue[0];

    const idx = this.queueIndex.get(guildId) || 0;
    const mod = filtered[idx % filtered.length];
    this.queueIndex.set(guildId, (idx + 1) % filtered.length);
    return mod;
  }

  async updateModStats(guildId, modId, ticketCreatedAt) {
    const responseTime = Date.now() - ticketCreatedAt;
    await this.db.query(`
      INSERT INTO mod_stats (guild_id, mod_id, tickets_handled, avg_response_ms, last_active)
      VALUES (?, ?, 1, ?, ?)
      ON DUPLICATE KEY UPDATE
        tickets_handled = tickets_handled + 1,
        avg_response_ms = (avg_response_ms + VALUES(avg_response_ms)) / 2,
        last_active = VALUES(last_active)
    `, [guildId, modId, responseTime, Date.now()]);
  }

  async generateTranscript(channel, ticket) {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return "Не удалось получить сообщения.";
    const lines = [...messages.values()]
      .reverse()
      .map(m => `[${new Date(m.createdTimestamp).toLocaleString("ru-RU")}] ${m.author.tag}: ${m.content || "[вложение]"}`)
      .join("\n");
    return `Транскрипт тикета ${ticket.ticket_id}\n${"=".repeat(50)}\n${lines}`;
  }

  formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0)  return `${d}д ${h % 24}ч`;
    if (h > 0)  return `${h}ч ${m % 60}мин`;
    return `${m}мин`;
  }

  chunkString(str, size) {
    const chunks = [];
    for (let i = 0; i < str.length; i += size) chunks.push(str.slice(i, i + size));
    return chunks;
  }
}

module.exports = { TicketManager };