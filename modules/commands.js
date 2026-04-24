// modules/commands.js — AUREX-9 v3.0 | Регистрация slash-команд
const { REST, Routes, SlashCommandBuilder } = require("discord.js");

class CommandRegistry {
  constructor(client, db) { this.client = client; this.db = db; }

  getCommands() {
    return [
      // ── ПАНЕЛЬ ──
      new SlashCommandBuilder().setName("панель").setDescription("⚙️ Панель управления AUREX-9 (Admin)"),
      new SlashCommandBuilder().setName("настройки").setDescription("⚙️ Открыть настройки бота"),

      // ── МОДЕРАЦИЯ ──
      new SlashCommandBuilder().setName("варн").setDescription("⚠️ Выдать предупреждение")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true))
        .addStringOption(o=>o.setName("причина").setDescription("Причина").setRequired(true)),
      new SlashCommandBuilder().setName("снятьварн").setDescription("✅ Снять предупреждения")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true)),
      new SlashCommandBuilder().setName("предупреждения").setDescription("📊 Просмотр предупреждений")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true)),
      new SlashCommandBuilder().setName("мут").setDescription("🔇 Выдать мут")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true))
        .addIntegerOption(o=>o.setName("минуты").setDescription("Длительность (мин)").setMinValue(1).setMaxValue(43200))
        .addStringOption(o=>o.setName("причина").setDescription("Причина")),
      new SlashCommandBuilder().setName("снятьмут").setDescription("🔓 Снять мут")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true)),
      new SlashCommandBuilder().setName("кик").setDescription("👢 Кикнуть пользователя")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true))
        .addStringOption(o=>o.setName("причина").setDescription("Причина")),
      new SlashCommandBuilder().setName("бан").setDescription("⛔ Забанить пользователя")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true))
        .addStringOption(o=>o.setName("причина").setDescription("Причина"))
        .addIntegerOption(o=>o.setName("дни").setDescription("Удалить сообщения за N дней").setMinValue(0).setMaxValue(7)),
      new SlashCommandBuilder().setName("разбан").setDescription("✅ Разбанить пользователя")
        .addStringOption(o=>o.setName("id").setDescription("ID пользователя").setRequired(true)),
      new SlashCommandBuilder().setName("очистить").setDescription("🗑️ Удалить сообщения в канале")
        .addIntegerOption(o=>o.setName("количество").setDescription("Кол-во (макс. 100)").setMinValue(1).setMaxValue(100))
        .addUserOption(o=>o.setName("пользователь").setDescription("Только от этого пользователя")),
      new SlashCommandBuilder().setName("медленный").setDescription("🐢 Режим медленного чата")
        .addIntegerOption(o=>o.setName("секунды").setDescription("Секунды (0 = выкл)").setMinValue(0).setMaxValue(21600).setRequired(true)),
      new SlashCommandBuilder().setName("заблокировать").setDescription("🔒 Заблокировать канал")
        .addStringOption(o=>o.setName("причина").setDescription("Причина")),
      new SlashCommandBuilder().setName("разблокировать").setDescription("🔓 Разблокировать канал"),
      new SlashCommandBuilder().setName("история").setDescription("📜 История действий модератора или пользователя")
        .addUserOption(o=>o.setName("пользователь").setDescription("Пользователь").setRequired(true))
        .addStringOption(o=>o.setName("тип").setDescription("Тип: all/warn/mute/ban").addChoices(
          {name:"Все",value:"all"},{name:"Предупреждения",value:"warn"},
          {name:"Муты",value:"mute"},{name:"Баны",value:"ban"}
        )),
      new SlashCommandBuilder().setName("снятьмодер").setDescription("🚨 (Admin) Снять модератора вручную")
        .addUserOption(o=>o.setName("пользователь").setDescription("Модератор").setRequired(true))
        .addStringOption(o=>o.setName("причина").setDescription("Причина").setRequired(true)),

      // ── ТИКЕТЫ ──
      new SlashCommandBuilder().setName("тикет").setDescription("🎫 Управление тикетами")
        .addSubcommand(s=>s.setName("создать").setDescription("Создать тикет"))
        .addSubcommand(s=>s.setName("закрыть").setDescription("Закрыть тикет").addStringOption(o=>o.setName("причина").setDescription("Причина")))
        .addSubcommand(s=>s.setName("добавить").setDescription("Добавить в тикет").addUserOption(o=>o.setName("пользователь").setDescription("Кого добавить").setRequired(true)))
        .addSubcommand(s=>s.setName("список").setDescription("Список открытых тикетов"))
        .addSubcommand(s=>s.setName("панель").setDescription("Развернуть панель тикетов")),

      // ── ИНФОРМАЦИЯ ──
      new SlashCommandBuilder().setName("профиль").setDescription("📊 Профиль и статистика")
        .addUserOption(o=>o.setName("пользователь").setDescription("Пользователь")),
      new SlashCommandBuilder().setName("рейтинг").setDescription("🏆 Рейтинг модераторов"),
      new SlashCommandBuilder().setName("сервер").setDescription("🏛 Информация о сервере"),
      new SlashCommandBuilder().setName("пользователь").setDescription("👤 Информация о пользователе")
        .addUserOption(o=>o.setName("пользователь").setDescription("Пользователь")),
      new SlashCommandBuilder().setName("правила").setDescription("📋 Правила сервера"),

      // ── ЭКОНОМИКА ──
      new SlashCommandBuilder().setName("баланс").setDescription("💰 Баланс монет")
        .addUserOption(o=>o.setName("пользователь").setDescription("Пользователь")),
      new SlashCommandBuilder().setName("ежедневно").setDescription("🎁 Ежедневная награда"),
      new SlashCommandBuilder().setName("работа").setDescription("💼 Заработать монеты"),
      new SlashCommandBuilder().setName("перевести").setDescription("💸 Передать монеты")
        .addUserOption(o=>o.setName("пользователь").setDescription("Кому").setRequired(true))
        .addIntegerOption(o=>o.setName("сумма").setDescription("Сумма").setMinValue(1).setRequired(true)),
      new SlashCommandBuilder().setName("топ").setDescription("📈 Таблица лидеров")
        .addStringOption(o=>o.setName("тип").setDescription("Тип").addChoices(
          {name:"По уровням",value:"xp"},{name:"По монетам",value:"coins"}
        )),
      new SlashCommandBuilder().setName("магазин").setDescription("🛒 Магазин сервера"),
      new SlashCommandBuilder().setName("дать").setDescription("💰 (Admin) Выдать монеты")
        .addUserOption(o=>o.setName("пользователь").setDescription("Кому").setRequired(true))
        .addIntegerOption(o=>o.setName("сумма").setDescription("Сумма").setRequired(true)),

      // ── МУЗЫКА ──
      new SlashCommandBuilder().setName("играть").setDescription("🎵 Воспроизвести музыку")
        .addStringOption(o=>o.setName("запрос").setDescription("Название или ссылка").setRequired(true)),
      new SlashCommandBuilder().setName("пауза").setDescription("⏸ Пауза"),
      new SlashCommandBuilder().setName("продолжить").setDescription("▶️ Продолжить"),
      new SlashCommandBuilder().setName("пропустить").setDescription("⏭ Пропустить трек"),
      new SlashCommandBuilder().setName("стоп").setDescription("⏹ Остановить плеер"),
      new SlashCommandBuilder().setName("очередь").setDescription("📋 Показать очередь"),
      new SlashCommandBuilder().setName("громкость").setDescription("🔊 Установить громкость (0-200)")
        .addIntegerOption(o=>o.setName("громкость").setDescription("0-200").setMinValue(0).setMaxValue(200).setRequired(true)),
      new SlashCommandBuilder().setName("повтор").setDescription("🔁 Повтор текущего трека"),

      // ── AI ──
      new SlashCommandBuilder().setName("aiблок").setDescription("🤖 (Mod) Заблокировать AI для пользователя")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true))
        .addIntegerOption(o=>o.setName("минуты").setDescription("На сколько минут (0 = навсегда)").setRequired(true))
        .addStringOption(o=>o.setName("причина").setDescription("Причина")),
      new SlashCommandBuilder().setName("aiразблок").setDescription("🤖 (Mod) Снять AI-блок")
        .addUserOption(o=>o.setName("пользователь").setDescription("Цель").setRequired(true)),

    ].map(c => c.toJSON());
  }

  async register(token, clientId) {
    const rest = new REST({ version: "10" }).setToken(token);
    try {
      console.log("🔄 Регистрация slash-команд...");
      await rest.put(Routes.applicationCommands(clientId), { body: this.getCommands() });
      console.log("✅ Slash-команды зарегистрированы.");
    } catch (e) { console.error("❌ Ошибка регистрации команд:", e.message); }
  }
}

module.exports = { CommandRegistry };
