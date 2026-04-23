// ═══════════════════════════════════════════════════════════════
//  modules/panel-functions.js — AUREX-9 v3.0
//  Все функции: экономика, защиты, кланы, события, ControlPanel
//  (используется из panel-commands.js)
// ═══════════════════════════════════════════════════════════════

const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
  Events, AttachmentBuilder, PermissionFlagsBits,
} = require("discord.js");

const { getGuildSetting, setGuildSetting, getAllGuildSettings } = require("./settings");

// Canvas — опционально
let Canvas;
try { Canvas = require("canvas"); } catch { Canvas = null; }

// ─── СОСТОЯНИЕ ────────────────────────────────────────────────
const xpCooldowns  = new Map();   // `guildId_userId` → timestamp
const raidJoinMap  = new Map();   // guildId → timestamps[]
const raidLockdown = new Map();   // guildId → bool
const duelMap      = new Map();   // `guildId_userId` → { targetId, amount, ts }

// ─── КОНФИГ ───────────────────────────────────────────────────
const CFG = {
  XP_COOLDOWN:      5_000,
  DAILY_REWARD_MIN: 400,
  DAILY_REWARD_MAX: 600,
  WORK_REWARD_MIN:  50,
  WORK_REWARD_MAX:  200,
  WORK_COOLDOWN:    3_600_000,
  DAILY_COOLDOWN:   86_400_000,
  CASE_COST:        100,
  RAID_THRESHOLD:   8,
  RAID_WINDOW:      10_000,
  XP_BUFF_COST:     500,
  XP_BUFF_HOURS:    2,
};

// ─── DB HELPER ────────────────────────────────────────────────
async function q(db, sql, params = []) {
  try   { return await db.query(sql, params); }
  catch (e) { console.error("[PanelDB]", e.message); return [[], []]; }
}

// ─── ECO USER ─────────────────────────────────────────────────
async function getEcoUser(db, guildId, userId) {
  const [r] = await q(db, "SELECT * FROM eco_users WHERE guild_id=? AND user_id=?", [guildId, userId]);
  if (r.length) return r[0];
  await q(db, "INSERT IGNORE INTO eco_users (guild_id,user_id) VALUES (?,?)", [guildId, userId]);
  const [r2] = await q(db, "SELECT * FROM eco_users WHERE guild_id=? AND user_id=?", [guildId, userId]);
  return r2[0] || { guild_id: guildId, user_id: userId, coins: 0, xp: 0, level: 1, messages: 0, last_daily: 0, last_work: 0 };
}

function xpNeed(lvl) { return lvl * 100 + 100; }

async function getXPBuff(db, guildId, userId) {
  const [r] = await q(db, "SELECT multiplier FROM panel_xp_buffs WHERE guild_id=? AND user_id=? AND expires_at>?",
    [guildId, userId, Date.now()]);
  return r.length ? r[0].multiplier : 1;
}

// ═══════════════════════════════════════════════════════════════
//  ЭКОНОМИКА
// ═══════════════════════════════════════════════════════════════

// ─── XP за сообщения ──────────────────────────────────────────
async function addMessageXP(msg, db) {
  if (msg.author.bot || !msg.guild) return;
  const key  = `${msg.guild.id}_${msg.author.id}`;
  const last = xpCooldowns.get(key) || 0;
  if (Date.now() - last < CFG.XP_COOLDOWN) return;
  xpCooldowns.set(key, Date.now());

  const guildId = msg.guild.id;
  const userId  = msg.author.id;
  const buff    = db ? await getXPBuff(db, guildId, userId) : 1;
  const u       = await getEcoUser(db, guildId, userId);
  const xpGain  = Math.floor((Math.random() * 10 + 5) * buff);

  let xp    = (u.xp || 0) + xpGain;
  let level = u.level || 1;
  let bonus = 0;

  while (xp >= xpNeed(level)) {
    xp -= xpNeed(level);
    level++;
    bonus += level * 100;
    try {
      await msg.channel.send({ embeds: [new EmbedBuilder()
        .setTitle("🎉 Повышение уровня!")
        .setColor(0xffd700)
        .setDescription(`<@${userId}> достиг **${level}** уровня!`)
        .addFields({ name: "💰 Награда", value: `+${level * 100} монет` })
        .setTimestamp()
      ]});
    } catch {}
  }

  await q(db, "UPDATE eco_users SET xp=?,level=?,messages=messages+1,coins=coins+? WHERE guild_id=? AND user_id=?",
    [xp, level, bonus, guildId, userId]).catch(() => {});
}

// ─── ПРОФИЛЬ ──────────────────────────────────────────────────
async function showProfile(interaction, db) {
  const target = interaction.options?.getUser("пользователь") || interaction.user;
  const u      = await getEcoUser(db, interaction.guild.id, target.id);
  u.coins = u.coins ?? 0; u.xp = u.xp ?? 0; u.level = u.level ?? 1;
  u.messages = u.messages ?? 0; u.voice_mins = u.voice_mins ?? 0;

  const need     = xpNeed(u.level);
  const progress = Math.min(u.xp / need, 1);
  const [[rankRow]] = await q(db,
    "SELECT COUNT(*)+1 as rank FROM eco_users WHERE guild_id=? AND (level*1000+xp)>(?*1000+?)",
    [interaction.guild.id, u.level, u.xp]);
  const rank = rankRow?.rank || 1;
  const buff = await getXPBuff(db, interaction.guild.id, target.id);

  if (Canvas) {
    return renderProfileCanvas(interaction, db, target, u, need, progress, rank, buff);
  }

  // Fallback embed
  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle(`📊 Профиль — ${target.username}`)
    .setColor(0xff2d2d)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "⭐ Уровень",     value: `**${u.level}**`,           inline: true },
      { name: "📈 XP",          value: `${u.xp}/${need}`,           inline: true },
      { name: "🏆 Ранг",        value: `#${rank}`,                  inline: true },
      { name: "💰 Монеты",      value: `${u.coins}`,                inline: true },
      { name: "💬 Сообщений",   value: `${u.messages}`,             inline: true },
      { name: "🎤 Голос (мин)", value: `${u.voice_mins}`,           inline: true },
      { name: "⚡ XP Буфф",    value: buff > 1 ? `x${buff} 🔥` : "Нет", inline: true }
    ).setTimestamp()
  ]});
}

async function renderProfileCanvas(interaction, db, target, u, need, progress, rank, buff) {
  const canvas = Canvas.createCanvas(1100, 450);
  const ctx    = canvas.getContext("2d");

  const [bgRows] = await q(db,
    "SELECT b.url FROM panel_inventory i JOIN panel_backgrounds b ON b.name=i.item WHERE i.guild_id=? AND i.user_id=? ORDER BY i.acquired_at DESC LIMIT 1",
    [interaction.guild.id, target.id]);
  const bgUrl = bgRows[0]?.url || "https://i.imgur.com/UaWcQe1.png";

  try {
    const bg = await Canvas.loadImage(bgUrl);
    ctx.drawImage(bg, 0, 0, 1100, 450);
  } catch {
    ctx.fillStyle = "#1a0a2e"; ctx.fillRect(0, 0, 1100, 450);
  }

  ctx.fillStyle = "rgba(0,0,0,0.55)"; ctx.fillRect(0, 0, 1100, 450);
  const grad = ctx.createLinearGradient(0, 0, 1100, 450);
  grad.addColorStop(0, "rgba(255,0,80,0.3)");
  grad.addColorStop(1, "rgba(0,100,255,0.3)");
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 1100, 450);

  ctx.fillStyle = "rgba(10,10,20,0.85)";
  roundRect(ctx, 40, 40, 1020, 370, 28); ctx.fill();

  try {
    const av = await Canvas.loadImage(target.displayAvatarURL({ extension: "png", size: 256 }));
    ctx.save(); ctx.beginPath(); ctx.arc(185, 225, 105, 0, Math.PI * 2);
    ctx.closePath(); ctx.clip(); ctx.drawImage(av, 80, 120, 210, 210); ctx.restore();
    ctx.lineWidth = 6; ctx.strokeStyle = buff > 1 ? "#ffd700" : "#ff2d2d";
    ctx.beginPath(); ctx.arc(185, 225, 105, 0, Math.PI * 2); ctx.stroke();
  } catch {}

  ctx.fillStyle = "#fff"; ctx.font = "bold 46px Arial";
  ctx.fillText(target.username, 330, 130);
  ctx.font = "26px Arial"; ctx.fillStyle = "#aaa";
  ctx.fillText(`Уровень ${u.level}  •  Ранг #${rank}`, 330, 175);

  roundRect(ctx, 330, 205, 680, 22, 8); ctx.fillStyle = "#111"; ctx.fill();
  if (progress > 0) {
    roundRect(ctx, 330, 205, 680 * progress, 22, 8);
    ctx.fillStyle = "#ff2d2d"; ctx.fill();
  }
  ctx.fillStyle = "#fff"; ctx.font = "18px Arial";
  ctx.fillText(`${u.xp}/${need} XP`, 620, 225);

  const stats = [
    ["💰 Монеты",    u.coins],
    ["💬 Сообщения", u.messages],
    ["🎤 Голос",     `${u.voice_mins} мин`],
    ["⚡ Буфф",      buff > 1 ? `x${buff} 🔥` : "нет"],
  ];
  stats.forEach(([label, val], idx) => {
    const x = 330 + (idx % 2) * 340;
    const y = 285 + Math.floor(idx / 2) * 60;
    ctx.font = "22px Arial"; ctx.fillStyle = "#ccc";
    ctx.fillText(`${label}: `, x, y);
    ctx.fillStyle = "#fff"; ctx.font = "bold 22px Arial";
    ctx.fillText(String(val), x + ctx.measureText(`${label}: `).width, y);
  });

  const buf = canvas.toBuffer("image/png");
  return interaction.editReply({ files: [new AttachmentBuilder(buf, { name: "profile.png" })] });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y);
  ctx.quadraticCurveTo(x+w,y,x+w,y+r); ctx.lineTo(x+w,y+h-r);
  ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r);
  ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

// ─── БАЛАНС ───────────────────────────────────────────────────
async function showBalance(interaction, db) {
  const u = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("💰 Баланс")
    .setColor(0xffd700)
    .setDescription(`У тебя **${u.coins || 0} монет**`)
    .addFields(
      { name: "⭐ Уровень", value: `${u.level || 1}`, inline: true },
      { name: "📈 XP",     value: `${u.xp || 0}/${xpNeed(u.level || 1)}`, inline: true }
    )
    .setThumbnail(interaction.user.displayAvatarURL()).setTimestamp()
  ]});
}

// ─── ЕЖЕДНЕВНО ────────────────────────────────────────────────
async function claimDaily(interaction, db) {
  const u   = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  const now = Date.now();
  if (now - (u.last_daily || 0) < CFG.DAILY_COOLDOWN) {
    const left = Math.ceil((u.last_daily + CFG.DAILY_COOLDOWN - now) / 60000);
    return interaction.editReply(`⏳ Следующая награда через **${left} мин.**`);
  }
  const reward = Math.floor(Math.random() * (CFG.DAILY_REWARD_MAX - CFG.DAILY_REWARD_MIN)) + CFG.DAILY_REWARD_MIN;
  await q(db, "UPDATE eco_users SET coins=coins+?,last_daily=? WHERE guild_id=? AND user_id=?",
    [reward, now, interaction.guild.id, interaction.user.id]);
  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("🎁 Ежедневная награда").setColor(0x00cc66)
    .setDescription(`Ты получил **${reward} монет**!`)
    .addFields({ name: "💰 Новый баланс", value: `${(u.coins||0)+reward}` })
    .setTimestamp()
  ]});
}

// ─── РАБОТА ───────────────────────────────────────────────────
async function doWork(interaction, db) {
  const u   = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  const now = Date.now();
  if (now - (u.last_work || 0) < CFG.WORK_COOLDOWN) {
    const left = Math.ceil((u.last_work + CFG.WORK_COOLDOWN - now) / 60000);
    return interaction.editReply(`⏳ Следующая работа через **${left} мин.**`);
  }
  const jobs   = ["💻 программист","🎨 дизайнер","🔒 модератор","📦 курьер","🎬 стример","📰 блогер","🔧 механик","🍕 повар"];
  const job    = jobs[Math.floor(Math.random() * jobs.length)];
  const reward = Math.floor(Math.random() * (CFG.WORK_REWARD_MAX - CFG.WORK_REWARD_MIN)) + CFG.WORK_REWARD_MIN;
  await q(db, "UPDATE eco_users SET coins=coins+?,last_work=? WHERE guild_id=? AND user_id=?",
    [reward, now, interaction.guild.id, interaction.user.id]);
  return interaction.editReply(`${job} — ты заработал **${reward} монет**! 💰`);
}

// ─── КЕЙС ─────────────────────────────────────────────────────
async function openCase(interaction, db) {
  const u = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u.coins||0) < CFG.CASE_COST)
    return interaction.editReply(`❌ Нужно **${CFG.CASE_COST}** монет. У тебя: **${u.coins||0}**.`);

  await q(db, "UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?",
    [CFG.CASE_COST, interaction.guild.id, interaction.user.id]);

  const rewards = [
    { label:"💸 50",     value:50,    chance:35 },
    { label:"💰 150",    value:150,   chance:25 },
    { label:"💎 400",    value:400,   chance:20 },
    { label:"🌟 800",    value:800,   chance:12 },
    { label:"🔥 2000",   value:2000,  chance:6  },
    { label:"💜 JACKPOT 10000", value:10000, chance:2 },
  ];
  const total = rewards.reduce((a,b) => a+b.chance, 0);
  let rng = Math.random()*total, chosen = rewards[0];
  for (const r of rewards) { rng -= r.chance; if (rng <= 0) { chosen=r; break; } }

  let txt = "🎰 ...";
  await interaction.editReply(txt);
  for (let k=0; k<7; k++) {
    const r = rewards[Math.floor(Math.random()*rewards.length)];
    try { await interaction.editReply(`🎰 ${r.label}`); } catch {}
    await new Promise(res => setTimeout(res, 180));
  }

  await q(db, "UPDATE eco_users SET coins=coins+? WHERE guild_id=? AND user_id=?",
    [chosen.value, interaction.guild.id, interaction.user.id]);

  const color = chosen.value >= 2000 ? 0xffd700 : chosen.value >= 800 ? 0x9900ff : 0x3399ff;
  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("🎰 Кейс открыт!").setColor(color)
    .setDescription(`${chosen.value>=2000?"🎊 ":""}Ты выиграл **${chosen.value} монет**!`)
    .addFields(
      { name:"💸 Потрачено", value:`${CFG.CASE_COST}`,            inline:true },
      { name:"💰 Получено",  value:`${chosen.value}`,             inline:true },
      { name:"📊 Профит",    value:`${chosen.value-CFG.CASE_COST}`,inline:true }
    ).setTimestamp()
  ]});
}

// ─── ТОП ──────────────────────────────────────────────────────
async function showTop(interaction, db, type = "xp") {
  const col = type === "coins" ? "coins DESC" : "level DESC, xp DESC";
  const [rows] = await q(db,
    `SELECT user_id,level,xp,coins FROM eco_users WHERE guild_id=? ORDER BY ${col} LIMIT 10`,
    [interaction.guild.id]);
  if (!rows.length) return interaction.editReply("ℹ️ Нет данных.");

  const medals = ["🥇","🥈","🥉"];
  const lines  = rows.map((r,i) => {
    const m   = medals[i] || `${i+1}.`;
    const name = interaction.guild.members.cache.get(r.user_id)?.user.username || `<@${r.user_id}>`;
    const val  = type==="coins" ? `💰 ${r.coins}` : `Ур.${r.level} | ${r.xp} XP`;
    return `${m} **${name}** — ${val}`;
  }).join("\n");

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle(type==="coins" ? "💰 Топ по монетам" : "⭐ Топ по уровням")
    .setDescription(lines).setColor(0xffd700).setTimestamp()
  ]});
}

// ─── МАГАЗИН ФОНОВ ────────────────────────────────────────────
async function showBgShop(interaction, db) {
  const [rows] = await q(db, "SELECT * FROM panel_backgrounds ORDER BY price");
  if (!rows.length) return interaction.editReply("❌ Нет фонов.");

  const rarityIcon = { common:"⚪", rare:"🔵", epic:"🟣", legendary:"🟡" };
  const embed = new EmbedBuilder()
    .setTitle("🎨 Магазин фонов профиля").setColor(0xff2d2d)
    .setDescription(rows.map(b => `${rarityIcon[b.rarity]||"⚪"} **${b.name}** — 💰 ${b.price}`).join("\n"))
    .setImage(rows[0]?.url);

  const chunks = [];
  for (let k=0; k<rows.length; k+=5)
    chunks.push(new ActionRowBuilder().addComponents(
      ...rows.slice(k,k+5).map(b =>
        new ButtonBuilder().setCustomId(`buybg_${b.id}`).setLabel(`Купить: ${b.name}`).setStyle(ButtonStyle.Secondary)
      )
    ));

  return interaction.editReply({ embeds:[embed], components:chunks.slice(0,5) });
}

async function buyBackground(interaction, db, bgId) {
  const [rows] = await q(db, "SELECT * FROM panel_backgrounds WHERE id=?", [bgId]);
  if (!rows.length) return interaction.editReply("❌ Фон не найден.");
  const bg = rows[0];
  const u  = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u.coins||0) < bg.price)
    return interaction.editReply(`❌ Нужно **${bg.price}** монет. У тебя: **${u.coins||0}**.`);

  const [has] = await q(db, "SELECT id FROM panel_inventory WHERE guild_id=? AND user_id=? AND item=?",
    [interaction.guild.id, interaction.user.id, bg.name]);
  if (has.length) return interaction.editReply("✅ Этот фон уже есть в инвентаре.");

  await q(db, "UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?",
    [bg.price, interaction.guild.id, interaction.user.id]);
  await q(db, "INSERT INTO panel_inventory (guild_id,user_id,item,amount,acquired_at) VALUES (?,?,?,1,?)",
    [interaction.guild.id, interaction.user.id, bg.name, Date.now()]);

  return interaction.editReply(`🎨 Фон **${bg.name}** куплен и добавлен в профиль!`);
}

// ─── ИНВЕНТАРЬ ────────────────────────────────────────────────
async function showInventory(interaction, db) {
  const [rows] = await q(db, "SELECT * FROM panel_inventory WHERE guild_id=? AND user_id=?",
    [interaction.guild.id, interaction.user.id]);
  if (!rows.length) return interaction.editReply("🎒 Инвентарь пуст.");

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("🎒 Инвентарь").setColor(0x3399ff)
    .setDescription(rows.map(r => `📦 **${r.item}** x${r.amount}`).join("\n"))
    .setTimestamp()
  ]});
}

// ─── РЫНОК ────────────────────────────────────────────────────
async function showMarket(interaction, db) {
  const [rows] = await q(db, "SELECT * FROM panel_market WHERE guild_id=? ORDER BY listed_at DESC LIMIT 10",
    [interaction.guild.id]);
  if (!rows.length) return interaction.editReply("🛒 Рынок пуст.");

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("🛒 Рынок игроков").setColor(0x00aa55)
    .setDescription(rows.map(r => {
      const seller = interaction.guild.members.cache.get(r.seller)?.user.username || `<@${r.seller}>`;
      return `**ID ${r.id}** | 📦 ${r.item} | 💰 ${r.price} | 👤 ${seller}`;
    }).join("\n"))
    .setFooter({ text:"Используй /купить-рынок <ID> для покупки" }).setTimestamp()
  ]});
}

async function buyMarketItem(interaction, db, itemId) {
  const [rows] = await q(db, "SELECT * FROM panel_market WHERE id=? AND guild_id=?",
    [itemId, interaction.guild.id]);
  if (!rows.length) return interaction.editReply("❌ Товар не найден.");

  const item = rows[0];
  if (item.seller === interaction.user.id) return interaction.editReply("❌ Нельзя покупать у себя.");

  const u = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u.coins||0) < item.price) return interaction.editReply(`❌ Нужно **${item.price}** монет.`);

  await q(db, "UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?",
    [item.price, interaction.guild.id, interaction.user.id]);
  await q(db, "INSERT INTO eco_users (guild_id,user_id,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=coins+?",
    [interaction.guild.id, item.seller, item.price, item.price]);
  await q(db, "DELETE FROM panel_market WHERE id=?", [itemId]);
  await q(db, "INSERT INTO panel_inventory (guild_id,user_id,item,amount,acquired_at) VALUES (?,?,?,1,?)",
    [interaction.guild.id, interaction.user.id, item.item, Date.now()]);

  return interaction.editReply(`✅ Куплено: **${item.item}** за **${item.price} монет**!`);
}

// ─── XP БУФФ ──────────────────────────────────────────────────
async function buyXPBuff(interaction, db) {
  const u = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u.coins||0) < CFG.XP_BUFF_COST)
    return interaction.editReply(`❌ Нужно **${CFG.XP_BUFF_COST}** монет.`);

  await q(db, "UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?",
    [CFG.XP_BUFF_COST, interaction.guild.id, interaction.user.id]);

  const expiresAt = Date.now() + CFG.XP_BUFF_HOURS * 3_600_000;
  await q(db, "INSERT INTO panel_xp_buffs (guild_id,user_id,multiplier,expires_at) VALUES (?,?,2.0,?) ON DUPLICATE KEY UPDATE multiplier=2.0,expires_at=?",
    [interaction.guild.id, interaction.user.id, expiresAt, expiresAt]);

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("⚡ XP Буфф x2 активирован!").setColor(0xffd700)
    .setDescription(`На **${CFG.XP_BUFF_HOURS} часа** твой XP удвоен!\n💰 Потрачено: **${CFG.XP_BUFF_COST}** монет.`)
    .setTimestamp()
  ]});
}

// ═══════════════════════════════════════════════════════════════
//  КЛАНЫ
// ═══════════════════════════════════════════════════════════════

async function createClan(interaction, db) {
  const guildId = interaction.guild.id;
  const [existing] = await q(db, "SELECT id FROM panel_clans WHERE guild_id=? AND owner=?",
    [guildId, interaction.user.id]);
  if (existing.length) return interaction.editReply("❌ У тебя уже есть клан.");

  const [mem] = await q(db, "SELECT clan_id FROM panel_clan_members WHERE guild_id=? AND user_id=?",
    [guildId, interaction.user.id]);
  if (mem.length) return interaction.editReply("❌ Ты уже состоишь в клане.");

  const name = `Clan_${interaction.user.username}`.slice(0, 32);
  let roleId = null;
  try {
    const role = await interaction.guild.roles.create({ name, color: "Red", reason: "Клан" });
    roleId = role.id;
    await interaction.member.roles.add(role);
  } catch {}

  const [res] = await q(db,
    "INSERT INTO panel_clans (guild_id,name,owner,role_id,created_at) VALUES (?,?,?,?,?)",
    [guildId, name, interaction.user.id, roleId, Date.now()]);

  if (res?.insertId) {
    await q(db, "INSERT INTO panel_clan_members (guild_id,clan_id,user_id,rank) VALUES (?,?,?,'owner')",
      [guildId, res.insertId, interaction.user.id]);
  }

  return interaction.editReply(`🧬 Клан **${name}** создан!`);
}

async function showClan(interaction, db) {
  const [mem] = await q(db, "SELECT * FROM panel_clan_members WHERE guild_id=? AND user_id=?",
    [interaction.guild.id, interaction.user.id]);
  if (!mem.length) return interaction.editReply("❌ Ты не состоишь в клане.");

  const [clanRows] = await q(db, "SELECT * FROM panel_clans WHERE id=?", [mem[0].clan_id]);
  if (!clanRows.length) return interaction.editReply("❌ Клан не найден.");
  const clan = clanRows[0];

  const [members] = await q(db, "SELECT user_id,rank FROM panel_clan_members WHERE clan_id=?", [clan.id]);

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle(`🧬 Клан: ${clan.name}`).setColor(0xff2d2d)
    .addFields(
      { name:"👑 Владелец",   value:`<@${clan.owner}>`,  inline:true },
      { name:"👥 Участников", value:`${members.length}`, inline:true },
      { name:"💰 Казна",      value:`${clan.coins}`,     inline:true },
      { name:"🏆 Победы",     value:`${clan.wins}`,      inline:true },
      { name:"💀 Поражения",  value:`${clan.losses}`,    inline:true }
    ).setTimestamp()
  ]});
}

// ─── ДУЭЛЬ ────────────────────────────────────────────────────
async function duelChallenge(interaction, db, targetUser, amount) {
  const u = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u.coins||0) < amount) return interaction.editReply("❌ Недостаточно монет.");
  if (targetUser.bot)                return interaction.editReply("❌ Нельзя вызвать бота.");
  if (targetUser.id === interaction.user.id) return interaction.editReply("❌ Нельзя вызвать себя.");

  const key = `${interaction.guild.id}_${interaction.user.id}`;
  duelMap.set(key, { targetId: targetUser.id, amount, ts: Date.now() });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`duel_accept_${interaction.user.id}_${amount}`).setLabel("✅ Принять").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`duel_decline_${interaction.user.id}`).setLabel("❌ Отклонить").setStyle(ButtonStyle.Danger)
  );

  return interaction.editReply({
    content: `⚔️ <@${targetUser.id}>, тебя вызывают на дуэль!\n💰 Ставка: **${amount} монет**`,
    components: [row]
  });
}

async function handleDuelAccept(interaction, db, challengerId, amount) {
  const key       = `${interaction.guild.id}_${challengerId}`;
  const challenge = duelMap.get(key);
  if (!challenge || challenge.targetId !== interaction.user.id)
    return interaction.editReply({ content:"❌ Вызов не найден.", components:[] });
  if (Date.now() - challenge.ts > 60_000) {
    duelMap.delete(key);
    return interaction.editReply({ content:"❌ Время вызова истекло.", components:[] });
  }

  const u1 = await getEcoUser(db, interaction.guild.id, challengerId);
  const u2 = await getEcoUser(db, interaction.guild.id, interaction.user.id);
  if ((u1.coins||0) < amount || (u2.coins||0) < amount) {
    duelMap.delete(key);
    return interaction.editReply({ content:"❌ Недостаточно монет у одного из участников.", components:[] });
  }

  const winner = Math.random() > 0.5 ? challengerId : interaction.user.id;
  const loser  = winner === challengerId ? interaction.user.id : challengerId;

  await q(db, "UPDATE eco_users SET coins=coins+? WHERE guild_id=? AND user_id=?", [amount, interaction.guild.id, winner]);
  await q(db, "UPDATE eco_users SET coins=coins-? WHERE guild_id=? AND user_id=?", [amount, interaction.guild.id, loser]);
  duelMap.delete(key);

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("⚔️ Дуэль завершена!").setColor(0xffd700)
    .setDescription(`🏆 Победитель: <@${winner}>\n💰 +**${amount}** монет`)
    .setTimestamp()
  ], components:[] });
}

// ═══════════════════════════════════════════════════════════════
//  СТАТИСТИКА СЕРВЕРА
// ═══════════════════════════════════════════════════════════════

async function showServerStats(interaction, db) {
  const guild  = interaction.guild;
  const dayAgo = Date.now() - 86_400_000;

  const [[violRow]] = await q(db, "SELECT COUNT(*) as cnt FROM mod_actions WHERE guild_id=? AND created_at>?",
    [guild.id, dayAgo]);
  const [[msgRow]]  = await q(db, "SELECT SUM(messages) as total FROM eco_users WHERE guild_id=?", [guild.id]);
  const [[tickRow]] = await q(db, "SELECT COUNT(*) as cnt FROM tickets WHERE guild_id=? AND status='open'", [guild.id]);
  const [[warnRow]] = await q(db, "SELECT SUM(count) as total FROM warnings WHERE guild_id=?", [guild.id]);

  const online   = guild.members.cache.filter(m => m.presence?.status !== "offline" && !m.user.bot).size;
  const bots     = guild.members.cache.filter(m => m.user.bot).size;
  const boosters = guild.premiumSubscriptionCount || 0;

  const autoMod = await getGuildSetting(db, guild.id, "auto_mod_enabled", true);

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle(`📊 Статистика: ${guild.name}`).setColor(0x3399ff)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name:"👥 Всего",          value:`${guild.memberCount}`,     inline:true },
      { name:"🟢 Онлайн",         value:`~${online}`,               inline:true },
      { name:"🤖 Ботов",          value:`${bots}`,                  inline:true },
      { name:"🚨 Нарушений (24ч)",value:`${violRow?.cnt||0}`,       inline:true },
      { name:"🎫 Открытых тикетов",value:`${tickRow?.cnt||0}`,      inline:true },
      { name:"⚠️ Всего варнов",   value:`${warnRow?.total||0}`,     inline:true },
      { name:"💬 Всего сообщений",value:`${msgRow?.total||0}`,      inline:true },
      { name:"🚀 Бустов",         value:`${boosters}`,              inline:true },
      { name:"⚙️ Авто-мод",       value:autoMod ? "✅ Вкл" : "❌ Выкл", inline:true }
    ).setFooter({ text:"AUREX-9 v3.0" }).setTimestamp()
  ]});
}

// ═══════════════════════════════════════════════════════════════
//  МОД-КОНТРОЛЬ (панельная версия)
// ═══════════════════════════════════════════════════════════════

async function showModControl(interaction, db) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.editReply("❌ Требуются права `Manage Guild`.");

  const guildId   = interaction.guild.id;
  const settings  = {
    auto_mod:    await getGuildSetting(db, guildId, "auto_mod_enabled",    true),
    anti_raid:   await getGuildSetting(db, guildId, "anti_raid_enabled",   true),
    anti_spam:   await getGuildSetting(db, guildId, "anti_spam_enabled",   true),
    gif_filter:  await getGuildSetting(db, guildId, "gif_filter_enabled",  true),
    link_filter: await getGuildSetting(db, guildId, "link_filter_enabled", false),
    ai_mod:      await getGuildSetting(db, guildId, "ai_mod_enabled",      false),
    verify:      await getGuildSetting(db, guildId, "verification_enabled",false),
  };

  const s2b = v => v === true || v === "true";
  const btn = (id, label, state) =>
    new ButtonBuilder().setCustomId(id)
      .setLabel(`${s2b(state)?"✅":"❌"} ${label}`)
      .setStyle(s2b(state) ? ButtonStyle.Success : ButtonStyle.Secondary);

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setTitle("⚙️ Мод-контроль").setColor(0xff6600)
      .setDescription("Нажимайте кнопки для вкл/выкл защит")
      .addFields(
        { name:"🤖 Авто-мод",      value:s2b(settings.auto_mod)   ?"✅":"❌", inline:true },
        { name:"⚔️ Анти-рейд",     value:s2b(settings.anti_raid)  ?"✅":"❌", inline:true },
        { name:"🚫 Анти-спам",     value:s2b(settings.anti_spam)  ?"✅":"❌", inline:true },
        { name:"🎞️ GIF фильтр",    value:s2b(settings.gif_filter) ?"✅":"❌", inline:true },
        { name:"🔗 Ссылки",        value:s2b(settings.link_filter)?"✅":"❌", inline:true },
        { name:"🧠 AI Модерация",  value:s2b(settings.ai_mod)     ?"✅":"❌", inline:true },
        { name:"🔒 Верификация",   value:s2b(settings.verify)     ?"✅":"❌", inline:true }
      ).setTimestamp()
    ],
    components: [
      new ActionRowBuilder().addComponents(
        btn("toggle_automod",   "Авто-мод",    settings.auto_mod),
        btn("toggle_antiraid",  "Анти-рейд",   settings.anti_raid),
        btn("toggle_antispam",  "Анти-спам",   settings.anti_spam),
        btn("toggle_giffilter", "GIF фильтр",  settings.gif_filter)
      ),
      new ActionRowBuilder().addComponents(
        btn("toggle_linkfilter","Ссылки",      settings.link_filter),
        btn("toggle_aimod",     "AI Мод",      settings.ai_mod),
        btn("toggle_verify",    "Верификация", settings.verify),
        new ButtonBuilder().setCustomId("mod_stats_btn").setLabel("📊 AUREX Статистика").setStyle(ButtonStyle.Primary)
      )
    ]
  });
}

async function toggleSetting(interaction, db, key, label) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.editReply("❌ Нет прав.");
  const cur  = await getGuildSetting(db, interaction.guild.id, key, false);
  const next = (cur === true || cur === "true") ? "false" : "true";
  await setGuildSetting(db, interaction.guild.id, key, next);
  return interaction.editReply(`✅ **${label}** ${next==="true" ? "включена ✅" : "выключена ❌"}`);
}

async function showAurexStats(interaction, db) {
  if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild))
    return interaction.editReply("❌ Нет прав.");

  const guildId  = interaction.guild.id;
  const weekAgo  = Date.now() - 7 * 86_400_000;
  const [[matW]]  = await q(db, "SELECT value FROM aurex_weights WHERE guild_id=? AND `key`='mat'",  [guildId]);
  const [[spamW]] = await q(db, "SELECT value FROM aurex_weights WHERE guild_id=? AND `key`='spam'", [guildId]);
  const [[capsW]] = await q(db, "SELECT value FROM aurex_weights WHERE guild_id=? AND `key`='caps'", [guildId]);
  const [[pornW]] = await q(db, "SELECT value FROM aurex_weights WHERE guild_id=? AND `key`='porn'", [guildId]);
  const [[recent]] = await q(db,
    "SELECT COUNT(*) as total, SUM(CASE WHEN mod_decision=1 THEN 1 ELSE 0 END) as correct FROM aurex_training WHERE guild_id=? AND created_at>?",
    [guildId, weekAgo]);

  const total    = recent?.total || 0;
  const correct  = recent?.correct || 0;
  const accuracy = total > 0 ? Math.round((correct/total)*100) : 100;

  return interaction.editReply({ embeds: [new EmbedBuilder()
    .setTitle("🧠 AUREX-AI — Статистика").setColor(accuracy<65?0xff0000:accuracy<80?0xff9900:0x00cc66)
    .setDescription(accuracy<65 ? "⚠️ **Высокий % ошибок!** Снизьте чувствительность." : "✅ AUREX-9 работает нормально.")
    .addFields(
      { name:"🎯 Точность (7 дней)", value:`${accuracy}%`,        inline:true },
      { name:"📊 Проверено",         value:`${total} сообщений`,   inline:true },
      { name:"⚖️ Вес [мат]",         value:`${matW?.value ??1}`,   inline:true },
      { name:"⚖️ Вес [спам]",        value:`${spamW?.value??1}`,   inline:true },
      { name:"⚖️ Вес [капс]",        value:`${capsW?.value??1}`,   inline:true },
      { name:"⚖️ Вес [NSFW]",        value:`${pornW?.value??1}`,   inline:true }
    ).setTimestamp()
  ]});
}

// ═══════════════════════════════════════════════════════════════
//  ВЕРИФИКАЦИЯ
// ═══════════════════════════════════════════════════════════════

async function sendVerificationPanel(channel, guildId, db) {
  await channel.send({ embeds: [new EmbedBuilder()
    .setTitle("🔒 Верификация участников").setColor(0x3399ff)
    .setDescription("Нажми кнопку ниже, чтобы получить доступ к серверу.\n\n**Нажимая кнопку, ты подтверждаешь что ознакомился с правилами.**")
    .setFooter({ text:"AUREX-9 Verification" })
  ], components:[new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("verify_btn").setLabel("✅ Я не бот — Верифицироваться").setStyle(ButtonStyle.Success)
  )]});
}

async function handleVerification(interaction, db) {
  const guildId      = interaction.guild.id;
  const verifyRoleId = db ? await getGuildSetting(db, guildId, "verify_role") : null;

  if (verifyRoleId) {
    try {
      const role = interaction.guild.roles.cache.get(verifyRoleId);
      if (role) await interaction.member.roles.add(role);
    } catch {}
  }

  if (db) {
    await q(db,
      "INSERT INTO panel_verification (guild_id,user_id,verified_at,method) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE verified_at=?,method=?",
      [guildId, interaction.user.id, Date.now(), "button", Date.now(), "button"]
    );
  }

  return interaction.reply({ content:"✅ Верификация пройдена! Добро пожаловать!", ephemeral:true });
}

// ═══════════════════════════════════════════════════════════════
//  АНТИ-РЕЙД
// ═══════════════════════════════════════════════════════════════

async function checkAntiRaid(member, db) {
  const guildId = member.guild.id;
  const enabled = db ? await getGuildSetting(db, guildId, "anti_raid_enabled", true) : true;
  if (!enabled || enabled === "false") return;

  const now    = Date.now();
  const joins  = raidJoinMap.get(guildId) || [];
  const recent = joins.filter(t => now - t < CFG.RAID_WINDOW);
  recent.push(now);
  raidJoinMap.set(guildId, recent);

  if (recent.length < CFG.RAID_THRESHOLD || raidLockdown.get(guildId)) return;

  raidLockdown.set(guildId, true);
  if (db) await setGuildSetting(db, guildId, "verification_enabled", "true");

  try {
    const logCh = db ? await getGuildSetting(db, guildId, "log_channel") : null;
    if (logCh) {
      const ch = await member.client.channels.fetch(logCh).catch(() => null);
      if (ch?.isTextBased()) await ch.send({ embeds: [new EmbedBuilder()
        .setTitle("🚨 РЕЙД ОБНАРУЖЕН!").setColor(0xff0000)
        .setDescription(`**${recent.length}** аккаунтов за ${CFG.RAID_WINDOW/1000} сек!\nВерификация включена автоматически.`)
        .setTimestamp()
      ]});
    }
  } catch {}

  setTimeout(() => {
    raidLockdown.set(guildId, false);
    raidJoinMap.set(guildId, []);
  }, 600_000);
}

// ═══════════════════════════════════════════════════════════════
//  АВТО-СОБЫТИЯ (дроп монет)
// ═══════════════════════════════════════════════════════════════

function startAutoEvents(client, db) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const chId = await getGuildSetting(db, guild.id, "showcase_channel");
        if (!chId) continue;
        const ch = await client.channels.fetch(chId).catch(() => null);
        if (!ch?.isTextBased()) continue;

        const reward = Math.floor(Math.random() * 800 + 200);
        const [res]  = await q(db,
          "INSERT INTO panel_events (guild_id,channel_id,reward,created_at) VALUES (?,?,?,?)",
          [guild.id, chId, reward, Date.now()]);
        const eventId = res?.insertId;

        const msg = await ch.send({
          embeds: [new EmbedBuilder()
            .setTitle("🎉 Случайный дроп!").setColor(0xffd700)
            .setDescription(`💰 **${reward} монет** — первый кликнувший заберёт всё!`)
            .setFooter({ text:"Нажми как можно быстрее!" }).setTimestamp()
          ],
          components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`event_claim_${eventId}_${reward}`)
              .setLabel("💰 Забрать!").setStyle(ButtonStyle.Success)
          )]
        });

        if (eventId) await q(db, "UPDATE panel_events SET msg_id=? WHERE id=?", [msg.id, eventId]);
        setTimeout(() => msg.delete().catch(()=>{}), 300_000);
      } catch (e) { console.error("[AutoEvent]", e.message); }
    }
  }, 15 * 60 * 1000);
}

// ═══════════════════════════════════════════════════════════════
//  КЛАНОВЫЕ ВОЙНЫ
// ═══════════════════════════════════════════════════════════════

function startClanWars(client, db) {
  setInterval(async () => {
    for (const guild of client.guilds.cache.values()) {
      try {
        const [clans] = await q(db, "SELECT * FROM panel_clans WHERE guild_id=?", [guild.id]);
        if (clans.length < 2) continue;

        const a = clans[Math.floor(Math.random()*clans.length)];
        const b = clans[Math.floor(Math.random()*clans.length)];
        if (a.id === b.id) continue;

        const winner = Math.random()>0.5 ? a : b;
        const loser  = winner.id===a.id ? b : a;
        const reward = Math.floor(Math.random()*2000+500);

        await q(db, "UPDATE panel_clans SET wins=wins+1,coins=coins+? WHERE id=?", [reward, winner.id]);
        await q(db, "UPDATE panel_clans SET losses=losses+1 WHERE id=?",           [loser.id]);
        await q(db, "INSERT INTO eco_users (guild_id,user_id,coins) VALUES (?,?,?) ON DUPLICATE KEY UPDATE coins=coins+?",
          [guild.id, winner.owner, Math.floor(reward*0.5), Math.floor(reward*0.5)]);

        const chId = await getGuildSetting(db, guild.id, "showcase_channel");
        if (chId) {
          const ch = await client.channels.fetch(chId).catch(()=>null);
          if (ch?.isTextBased()) await ch.send({ embeds: [new EmbedBuilder()
            .setTitle("⚔️ Клановая война!").setColor(0xff2d2d)
            .setDescription(`**${a.name}** vs **${b.name}**\n\n🏆 Победитель: **${winner.name}**\n💰 Награда: **${reward}** в казну`)
            .setTimestamp()
          ]});
        }
      } catch (e) { console.error("[ClanWar]", e.message); }
    }
  }, 30*60*1000);
}

// ═══════════════════════════════════════════════════════════════
//  DEPLOY ГЛАВНОЙ ПАНЕЛИ
// ═══════════════════════════════════════════════════════════════

async function deployMainPanel(channel, guildId, db) {
  const embed = new EmbedBuilder()
    .setTitle("🚀 AUREX-9 v3.0 — Панель")
    .setColor(0xff2d2d)
    .setDescription([
      "**💎 Экономика** — Профиль, монеты, магазин, инвентарь",
      "**🎰 Игры** — Кейсы, дуэли, случайные дропы",
      "**🧬 Кланы** — Создай клан, участвуй в войнах",
      "**📊 Сервер** — Статистика и контроль модерации",
      "",
      "> Используй кнопки ниже"
    ].join("\n"))
    .setFooter({ text:"AUREX-9 Panel v2.0 • TGD" }).setTimestamp();

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pnl_profile").setLabel("👤 Профиль").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("pnl_balance").setLabel("💰 Баланс").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("pnl_daily").setLabel("🎁 Daily").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pnl_work").setLabel("💼 Работа").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("pnl_top").setLabel("🏆 Топ").setStyle(ButtonStyle.Secondary)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pnl_case").setLabel("🎰 Кейс (-100💰)").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("pnl_bgshop").setLabel("🎨 Фоны").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pnl_inventory").setLabel("🎒 Инвентарь").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pnl_market").setLabel("🛒 Рынок").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pnl_xpbuff").setLabel("⚡ XP x2").setStyle(ButtonStyle.Primary)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("pnl_clan_create").setLabel("🧬 Создать клан").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pnl_clan_info").setLabel("📋 Мой клан").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("pnl_stats").setLabel("📊 Статистика").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("pnl_modcontrol").setLabel("⚙️ Мод-контроль").setStyle(ButtonStyle.Danger)
  );

  await channel.send({ embeds:[embed], components:[row1, row2, row3] });
}

// ═══════════════════════════════════════════════════════════════
//  CONTROL PANEL (из control-panel.js) — объединено сюда
// ═══════════════════════════════════════════════════════════════

const MODULES = [
  { id:"automod_enabled",       label:"🤖 Авто-модерация",     desc:"AUREX-AI: мат, спам, NSFW" },
  { id:"tickets_enabled",       label:"🎫 Тикеты",              desc:"Система тикетов" },
  { id:"anticrash_enabled",     label:"🛡️ Анти-краш",          desc:"Защита от массовых банов/удалений" },
  { id:"audit_enabled",         label:"📋 Аудит логи",          desc:"Логирование событий" },
  { id:"flood_protection",      label:"🌊 Анти-флуд",           desc:"Авто-варн при флуде" },
  { id:"economy_enabled",       label:"💰 Экономика",           desc:"XP, монеты, магазин" },
  { id:"music_enabled",         label:"🎵 Музыка",              desc:"Музыкальный плеер" },
  { id:"ai_chat_enabled",       label:"🧠 AI-чат",              desc:"Ответы Groq LLM на упоминания" },
  { id:"server_status_enabled", label:"🛰 Статус сервера",      desc:"Игровой сервер онлайн" },
  { id:"rules_enabled",         label:"📜 Правила",             desc:"Команда /правила" },
  { id:"anti_raid_enabled",     label:"⚔️ Анти-рейд",           desc:"Защита от рейд-атак" },
  { id:"verification_enabled",  label:"🔒 Верификация",         desc:"Кнопка верификации при входе" },
  { id:"panel_events_enabled",  label:"🎉 Авто-дропы",          desc:"Случайные дропы монет" },
];

class ControlPanel {
  constructor(client, db, auditLogger) {
    this.client      = client;
    this.db          = db;
    this.auditLogger = auditLogger;
  }

  // ── ГЛАВНАЯ ПАНЕЛЬ ────────────────────────────────────────────
  async sendPanel(interaction) {
    const guildId = interaction.guild.id;
    const s       = await getAllGuildSettings(this.db, guildId);
    const enabled = s.enabled !== false;

    const statusLine = MODULES.map(m =>
      `${s[m.id]!==false ? "✅":"❌"} ${m.label}`
    ).join("\n");

    const embed = new EmbedBuilder()
      .setTitle("⚙️ AUREX-9 v3.0 — Панель управления")
      .setColor(enabled ? 0x3399ff : 0x888888)
      .setDescription(enabled
        ? "Бот **активен** на этом сервере."
        : "⚠️ Бот **отключён** на этом сервере.")
      .addFields(
        { name:"📦 Модули", value:statusLine, inline:false },
        { name:"📍 Каналы", value:[
          `📋 Логи: ${s.log_channel ? `<#${s.log_channel}>` : "—"}`,
          `🎫 Тикеты: ${s.ticket_panel_channel ? `<#${s.ticket_panel_channel}>` : "—"}`,
          `🛰 Статус: ${s.server_status_channel ? `<#${s.server_status_channel}>` : "—"}`,
          `🎉 Showcase: ${s.showcase_channel ? `<#${s.showcase_channel}>` : "—"}`,
          `🔒 Верификация: ${s.verify_role ? `<@&${s.verify_role}>` : "—"}`,
        ].join("\n"), inline:false }
      )
      .setFooter({ text:"AUREX-9 • Нажмите кнопку для настройки" }).setTimestamp();

    const rows = [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ctrl_modules").setLabel("📦 Модули").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_channels").setLabel("📍 Каналы").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_roles").setLabel("🛡️ Роли").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_moderation").setLabel("⚔️ Модерация").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_tickets").setLabel("🎫 Тикеты").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ctrl_aurex_ai").setLabel("🤖 AUREX-AI").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_music").setLabel("🎵 Музыка").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_economy").setLabel("💰 Экономика").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_rules").setLabel("📜 Правила").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_gameserver").setLabel("🛰 Сервер").setStyle(ButtonStyle.Secondary)
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ctrl_mod_control").setLabel("👮 Контроль модеров").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_shop").setLabel("🛒 Магазин").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_panel_channels").setLabel("🎉 Панель/Ивенты").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(enabled ? "ctrl_disable_bot" : "ctrl_enable_bot")
          .setLabel(enabled ? "🔌 Отключить" : "✅ Включить бота")
          .setStyle(enabled ? ButtonStyle.Danger : ButtonStyle.Success)
      )
    ];

    const opts = { embeds:[embed], components:rows, ephemeral:true };
    if (interaction.replied || interaction.deferred)
      return interaction.editReply(opts).catch(() => interaction.followUp(opts));
    return interaction.reply(opts);
  }

  async handleSettingsCommand(i) { return this.sendPanel(i); }

  // ── КНОПКИ ────────────────────────────────────────────────────
  async handleButton(interaction) {
    const { customId, guild, member } = interaction;
    const guildId = guild.id;

    if (!member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content:"❌ Только администраторы.", ephemeral:true });

    // Модалки — нельзя вызывать после defer/reply
    const modalTriggers = [
      "ctrl_channels","ctrl_roles","ctrl_moderation","ctrl_tickets",
      "ctrl_gameserver","ctrl_rules_server","ctrl_rules_discord","ctrl_rules_ai",
      "ctrl_music_config","ctrl_ai_config","ctrl_ai_weights","ctrl_ai_prompt","ctrl_ai_limits",
      "ctrl_shop","ctrl_panel_channels",
    ];
    if (modalTriggers.includes(customId)) {
      return this._handleModalTrigger(interaction, customId, guildId);
    }

    switch (customId) {
      case "ctrl_enable_bot":
        await setGuildSetting(this.db, guildId, "enabled", true);
        return interaction.reply({ content:"✅ Бот **включён**.", ephemeral:true });

      case "ctrl_disable_bot":
        await setGuildSetting(this.db, guildId, "enabled", false);
        return interaction.reply({ content:"🔌 Бот **отключён**.", ephemeral:true });

      case "ctrl_modules":     return this.showModulesMenu(interaction, guildId);
      case "ctrl_aurex_ai":    return this.showAurexAiSettings(interaction, guildId);
      case "ctrl_music":       return this.showMusicSettings(interaction, guildId);
      case "ctrl_music_toggle": {
        const cur = await getGuildSetting(this.db, guildId, "music_enabled", true);
        await setGuildSetting(this.db, guildId, "music_enabled", !cur);
        return interaction.reply({ content:`${!cur?"✅":"❌"} Музыка ${!cur?"включена":"выключена"}.`, ephemeral:true });
      }
      case "ctrl_economy":     return this.showEconomySettings(interaction, guildId);
      case "ctrl_rules":       return this.showRulesPanel(interaction, guildId);
      case "ctrl_mod_control": return this.showModControl(interaction, guildId);
      case "ctrl_mod_actions": return this.handleAiSubButton(interaction, guildId);
      case "ctrl_mod_reset":   return this.handleAiSubButton(interaction, guildId);
      case "ctrl_ai_config":
      case "ctrl_ai_weights":
      case "ctrl_ai_prompt":
      case "ctrl_ai_limits":   return this.handleAiSubButton(interaction, guildId);

      default:
        return interaction.reply({ content:"❓ Неизвестная кнопка. Попробуй /панель заново.", ephemeral:true });
    }
  }

  async _handleModalTrigger(interaction, customId, guildId) {
    if (customId === "ctrl_channels")     return this.showChannelsModal(interaction, guildId);
    if (customId === "ctrl_roles")        return this.showRolesModal(interaction, guildId);
    if (customId === "ctrl_moderation")   return this.showModerationModal(interaction, guildId);
    if (customId === "ctrl_tickets")      return this.showTicketsModal(interaction, guildId);
    if (customId === "ctrl_gameserver")   return this.showGameServerModal(interaction, guildId);
    if (customId === "ctrl_rules_server") return this.showRulesModal(interaction, guildId, "server");
    if (customId === "ctrl_rules_discord")return this.showRulesModal(interaction, guildId, "discord");
    if (customId === "ctrl_rules_ai")     return this.showRulesModal(interaction, guildId, "ai");
    if (customId === "ctrl_music_config") return this.showMusicModal(interaction, guildId);
    if (customId === "ctrl_shop")         return this.showShopModal(interaction, guildId);
    if (customId === "ctrl_panel_channels") return this.showPanelChannelsModal(interaction, guildId);
    if (customId === "ctrl_ai_config" || customId === "ctrl_ai_weights" ||
        customId === "ctrl_ai_prompt" || customId === "ctrl_ai_limits")
      return this.handleAiSubButton(interaction, guildId);
  }

  // ── МЕНЮ МОДУЛЕЙ ─────────────────────────────────────────────
  async showModulesMenu(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const menu = new StringSelectMenuBuilder()
      .setCustomId("ctrl_toggle_module")
      .setPlaceholder("Выберите модуль для переключения...")
      .setMinValues(1).setMaxValues(1)
      .addOptions(MODULES.map(m => ({
        label:       m.label,
        value:       m.id,
        description: `Сейчас: ${s[m.id]!==false?"✅ Вкл":"❌ Выкл"} — ${m.desc}`
      })));
    return interaction.reply({ content:"📦 **Модули:** Выберите для переключения:",
      components:[new ActionRowBuilder().addComponents(menu)], ephemeral:true });
  }

  // ── КАНАЛЫ ────────────────────────────────────────────────────
  async showChannelsModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const modal = new ModalBuilder().setCustomId("ctrl_modal_channels").setTitle("📍 Настройка каналов");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("log_channel").setLabel("ID канала для логов (аудит)").setStyle(TextInputStyle.Short).setValue(s.log_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_panel_channel").setLabel("ID канала для панели тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_panel_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_log_channel").setLabel("ID канала для логов тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_log_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_category_channel").setLabel("ID категории для тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_category_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_status_channel").setLabel("ID канала статуса игрового сервера").setStyle(TextInputStyle.Short).setValue(s.server_status_channel||"").setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── НОВЫЕ КАНАЛЫ ПАНЕЛИ ────────────────────────────────────────
  async showPanelChannelsModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const modal = new ModalBuilder().setCustomId("ctrl_modal_panel_channels").setTitle("🎉 Каналы панели и ивентов");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("showcase_channel").setLabel("ID канала для панели / авто-дропов").setStyle(TextInputStyle.Short).setValue(s.showcase_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("welcome_channel").setLabel("ID канала для приветствий (welcome)").setStyle(TextInputStyle.Short).setValue(s.welcome_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("leave_channel").setLabel("ID канала для уходов (leave)").setStyle(TextInputStyle.Short).setValue(s.leave_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("boost_channel").setLabel("ID канала для буст-уведомлений").setStyle(TextInputStyle.Short).setValue(s.boost_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("verify_role").setLabel("ID роли после верификации").setStyle(TextInputStyle.Short).setValue(s.verify_role||"").setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── РОЛИ ──────────────────────────────────────────────────────
  async showRolesModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const parse = v => { try { return JSON.parse(v).join(","); } catch { return v||""; } };
    const modal = new ModalBuilder().setCustomId("ctrl_modal_roles").setTitle("🛡️ Настройка ролей");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("mod_roles").setLabel("ID ролей модераторов (через запятую)").setStyle(TextInputStyle.Short).setValue(parse(s.mod_roles)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("admin_roles").setLabel("ID ролей администраторов").setStyle(TextInputStyle.Short).setValue(parse(s.admin_roles)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("immune_roles").setLabel("ID защищённых ролей (без наказаний)").setStyle(TextInputStyle.Short).setValue(parse(s.immune_roles)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("protected_roles").setLabel("ID ролей без варна от авто-мода").setStyle(TextInputStyle.Short).setValue(parse(s.protected_roles)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cadet_role").setLabel("ID роли кадета (замена при снятии мода)").setStyle(TextInputStyle.Short).setValue(s.cadet_role||"").setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── МОДЕРАЦИЯ ─────────────────────────────────────────────────
  async showModerationModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const modal = new ModalBuilder().setCustomId("ctrl_modal_moderation").setTitle("⚔️ Настройки модерации");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("max_warnings").setLabel("Макс. предупреждений до мута").setStyle(TextInputStyle.Short).setValue(String(s.max_warnings||3)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("mute_duration_ms").setLabel("Длительность автомута (мс)").setStyle(TextInputStyle.Short).setValue(String(s.mute_duration_ms||600000)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("flood_limit").setLabel("Лимит сообщений за 8 сек (флуд)").setStyle(TextInputStyle.Short).setValue(String(s.flood_limit||5)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("anticrash_chan_limit").setLabel("Удалений каналов до снятия мода").setStyle(TextInputStyle.Short).setValue(String(s.anticrash_chan_limit||3)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("anticrash_ban_limit").setLabel("Банов за 60 сек до снятия мода").setStyle(TextInputStyle.Short).setValue(String(s.anticrash_ban_limit||5)).setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── ТИКЕТЫ ────────────────────────────────────────────────────
  async showTicketsModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const modal = new ModalBuilder().setCustomId("ctrl_modal_tickets").setTitle("🎫 Настройки тикетов");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_panel_channel").setLabel("ID канала для панели тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_panel_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_log_channel").setLabel("ID канала для логов тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_log_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_category_channel").setLabel("ID категории Discord для тикетов").setStyle(TextInputStyle.Short).setValue(s.ticket_category_channel||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_sla_hours").setLabel("SLA: время ответа (часов)").setStyle(TextInputStyle.Short).setValue(String(s.ticket_sla_hours||24)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ticket_auto_close_hours").setLabel("Авто-закрытие неактивных тикетов (ч)").setStyle(TextInputStyle.Short).setValue(String(s.ticket_auto_close_hours||48)).setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── AUREX-AI ──────────────────────────────────────────────────
  async showAurexAiSettings(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const embed = new EmbedBuilder()
      .setTitle("🤖 AUREX-AI — Настройки ИИ").setColor(0x9900ff)
      .setDescription("Управление ИИ-анализатором и Groq LLM чатом.")
      .addFields(
        { name:"🔑 Groq API",        value: s.groq_api_key ? "✅ Настроен" : "❌ Не настроен", inline:true },
        { name:"💬 AI-чат",          value: s.ai_chat_enabled!==false ? "✅":"❌",             inline:true },
        { name:"🛡️ Авто-мод",        value: s.automod_enabled!==false ? "✅":"❌",             inline:true },
        { name:"📊 Лимит (в сутки)", value: String(s.ai_daily_limit||5),                      inline:true },
        { name:"⏱ Блок за оскорб.", value: `${s.ai_insult_block_min||15} мин.`,               inline:true },
        { name:"⚖️ Чувствит. мата",  value: String(s.weight_mat||"1.5"),                      inline:true }
      ).setFooter({ text:"Используй кнопки ниже" });

    return interaction.reply({ embeds:[embed], components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ctrl_ai_config").setLabel("🔑 API / Лимиты").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_ai_weights").setLabel("⚖️ Веса").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_ai_prompt").setLabel("💬 Промпт").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("ctrl_ai_limits").setLabel("🚫 Каналы").setStyle(ButtonStyle.Secondary)
      )
    ], ephemeral:true });
  }

  // ── МУЗЫКА ────────────────────────────────────────────────────
  async showMusicSettings(interaction, guildId) {
    const s       = await getAllGuildSettings(this.db, guildId);
    const enabled = s.music_enabled !== false;
    const embed   = new EmbedBuilder()
      .setTitle("🎵 Музыка — Настройки").setColor(0x1db954)
      .addFields(
        { name:"🎵 Модуль",             value: enabled ? "✅ Включён":"❌ Выключен", inline:true },
        { name:"🔊 Громкость умолч.",    value: `${s.music_default_volume||50}%`,    inline:true },
        { name:"📋 Макс. очередь",      value: String(s.music_max_queue||100),       inline:true },
        { name:"🎧 Роль DJ",            value: s.music_dj_role?`<@&${s.music_dj_role}>`:"—", inline:true },
        { name:"📌 Канал команд",       value: s.music_allowed_channel?`<#${s.music_allowed_channel}>`:"везде", inline:true }
      );
    return interaction.reply({ embeds:[embed], components:[
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("ctrl_music_config").setLabel("⚙️ Настроить").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("ctrl_music_toggle")
          .setLabel(enabled?"❌ Выключить":"✅ Включить").setStyle(enabled?ButtonStyle.Danger:ButtonStyle.Success)
      )
    ], ephemeral:true });
  }

  async showMusicModal(interaction) {
    const modal = new ModalBuilder().setCustomId("ctrl_modal_music").setTitle("🎵 Настройки музыки");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("music_dj_role").setLabel("ID роли DJ").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Оставь пустым чтобы не менять")),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("music_max_queue").setLabel("Макс. треков в очереди").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Например: 100")),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("music_default_volume").setLabel("Громкость по умолчанию (0-200)").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("Например: 50")),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("music_allowed_channel").setLabel("ID канала для команд (пусто = везде)").setStyle(TextInputStyle.Short).setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── ЭКОНОМИКА ─────────────────────────────────────────────────
  async showEconomySettings(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    const modal = new ModalBuilder().setCustomId("ctrl_modal_economy").setTitle("💰 Настройки экономики");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("economy_xp_rate").setLabel("XP за сообщение (диапазон)").setStyle(TextInputStyle.Short).setValue(String(s.economy_xp_rate||"5-15")).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("economy_daily_min").setLabel("Мин. монет за /ежедневно").setStyle(TextInputStyle.Short).setValue(String(s.economy_daily_min||300)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("economy_daily_max").setLabel("Макс. монет за /ежедневно").setStyle(TextInputStyle.Short).setValue(String(s.economy_daily_max||500)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("economy_work_min").setLabel("Мин. монет за /работа").setStyle(TextInputStyle.Short).setValue(String(s.economy_work_min||50)).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("economy_levelup_bonus").setLabel("Монет за повышение уровня (×уровень)").setStyle(TextInputStyle.Short).setValue(String(s.economy_levelup_bonus||100)).setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── ПРАВИЛА ───────────────────────────────────────────────────
  async showRulesPanel(interaction, guildId) {
    return interaction.reply({ embeds:[new EmbedBuilder()
      .setTitle("📜 Управление правилами").setColor(0xff9900)
      .setDescription("Настройте правила для команды /правила.")
    ], components:[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ctrl_rules_server").setLabel("📋 Сервера").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ctrl_rules_discord").setLabel("⚖️ Discord").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("ctrl_rules_ai").setLabel("🤖 AI-чат").setStyle(ButtonStyle.Secondary)
    )], ephemeral:true });
  }

  async showRulesModal(interaction, guildId, type) {
    const [rows] = await this.db.query("SELECT title,content FROM server_rules WHERE guild_id=? AND type=? LIMIT 1", [guildId, type]);
    const existing = rows[0] || {};
    const titles   = { server:"📋 Правила сервера", discord:"⚖️ Правила Discord", ai:"🤖 Правила AI" };
    const modal = new ModalBuilder().setCustomId(`ctrl_modal_rules_${type}`).setTitle(titles[type]||"Правила");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("title").setLabel("Заголовок").setStyle(TextInputStyle.Short).setValue(existing.title||"").setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("content").setLabel("Текст правил (Markdown)").setStyle(TextInputStyle.Paragraph).setValue(existing.content||"").setRequired(true).setMaxLength(3800))
    );
    return interaction.showModal(modal);
  }

  // ── ИГРОВОЙ СЕРВЕР ────────────────────────────────────────────
  async showGameServerModal(interaction, guildId) {
    const s = await getAllGuildSettings(this.db, guildId);
    let cfg = {}; try { cfg = JSON.parse(s.game_server_config||"{}"); } catch {}
    const modal = new ModalBuilder().setCustomId("ctrl_modal_gameserver").setTitle("🛰 Игровой сервер");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_ip").setLabel("IP сервера").setStyle(TextInputStyle.Short).setValue(cfg.ip||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_port").setLabel("Порт").setStyle(TextInputStyle.Short).setValue(String(cfg.port||"27015")).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_name").setLabel("Название").setStyle(TextInputStyle.Short).setValue(cfg.name||"").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_type").setLabel("Тип (query/minecraft/fivem)").setStyle(TextInputStyle.Short).setValue(cfg.type||"query").setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("server_status_channel").setLabel("ID канала для статуса").setStyle(TextInputStyle.Short).setValue(s.server_status_channel||"").setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── КОНТРОЛЬ МОДЕРАТОРОВ ──────────────────────────────────────
  async showModControl(interaction, guildId) {
    const [stats] = await this.db.query(
      "SELECT ms.*,COUNT(ma.id) as total_actions FROM mod_stats ms LEFT JOIN mod_actions ma ON ms.mod_id=ma.mod_id AND ms.guild_id=ma.guild_id WHERE ms.guild_id=? GROUP BY ms.id ORDER BY ms.quality_score DESC LIMIT 15",
      [guildId]
    );
    if (!stats.length)
      return interaction.reply({ content:"ℹ️ Нет данных о модераторах.", ephemeral:true });

    const lines = stats.map((r, i) => {
      const name = interaction.guild.members.cache.get(r.mod_id)?.user.username || r.mod_id;
      const last = r.last_active ? `<t:${Math.floor(r.last_active/1000)}:R>` : "никогда";
      return `${i+1}. **${name}** | ⚠️${r.warns_issued||0} 🔇${r.mutes_issued||0} ⛔${r.bans_issued||0} 🎫${r.tickets_handled||0} | ${last}`;
    }).join("\n");

    return interaction.reply({ embeds:[new EmbedBuilder()
      .setTitle("👮 Статистика модераторов").setColor(0x3399ff)
      .setDescription(lines.slice(0,3800)).setTimestamp()
    ], components:[new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("ctrl_mod_actions").setLabel("📜 Последние действия").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("ctrl_mod_reset").setLabel("🔄 Сбросить").setStyle(ButtonStyle.Danger)
    )], ephemeral:true });
  }

  // ── МАГАЗИН ───────────────────────────────────────────────────
  async showShopModal(interaction, guildId) {
    const modal = new ModalBuilder().setCustomId("ctrl_modal_shop").setTitle("🛒 Добавить товар");
    modal.addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item_name").setLabel("Название товара").setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item_desc").setLabel("Описание").setStyle(TextInputStyle.Short).setRequired(false)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item_price").setLabel("Цена (монеты)").setStyle(TextInputStyle.Short).setRequired(true)),
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("item_role").setLabel("ID роли которую выдаёт товар (опц.)").setStyle(TextInputStyle.Short).setRequired(false))
    );
    return interaction.showModal(modal);
  }

  // ── ОБРАБОТКА SELECT ─────────────────────────────────────────
  async handleSelect(interaction) {
    const { customId, guild, member } = interaction;
    const guildId = guild.id;
    if (!member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content:"❌ Только администраторы.", ephemeral:true });

    if (customId === "ctrl_toggle_module") {
      const key = interaction.values[0];
      const cur = await getGuildSetting(this.db, guildId, key, true);
      await setGuildSetting(this.db, guildId, key, !cur);
      const mod = MODULES.find(m => m.id === key);
      return interaction.reply({ content:`${!cur?"✅":"❌"} ${mod?.label||key} ${!cur?"включён":"выключен"}.`, ephemeral:true });
    }
  }

  // ── ОБРАБОТКА МОДАЛЕЙ ─────────────────────────────────────────
  async handleModal(interaction) {
    const id      = interaction.customId;
    const guildId = interaction.guild.id;
    if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator))
      return interaction.reply({ content:"❌ Только администраторы.", ephemeral:true });

    if (id === "ctrl_modal_channels") {
      for (const f of ["log_channel","ticket_panel_channel","ticket_log_channel","ticket_category_channel","server_status_channel"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Каналы сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_panel_channels") {
      for (const f of ["showcase_channel","welcome_channel","leave_channel","boost_channel","verify_role"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Каналы панели сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_roles") {
      const parseIds = v => JSON.stringify(v.split(",").map(s=>s.trim()).filter(Boolean));
      for (const f of ["mod_roles","admin_roles","immune_roles","protected_roles"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v !== undefined) await setGuildSetting(this.db, guildId, f, parseIds(v));
      }
      const cadet = interaction.fields.getTextInputValue("cadet_role")?.trim();
      if (cadet) await setGuildSetting(this.db, guildId, "cadet_role", cadet);
      return interaction.reply({ content:"✅ Роли сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_moderation") {
      for (const f of ["max_warnings","mute_duration_ms","flood_limit","anticrash_chan_limit","anticrash_ban_limit"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v && !isNaN(v)) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Настройки модерации сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_tickets") {
      for (const f of ["ticket_panel_channel","ticket_log_channel","ticket_category_channel","ticket_sla_hours","ticket_auto_close_hours"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Настройки тикетов сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_gameserver") {
      const ip   = interaction.fields.getTextInputValue("server_ip")?.trim();
      const port = interaction.fields.getTextInputValue("server_port")?.trim();
      const name = interaction.fields.getTextInputValue("server_name")?.trim();
      const type = interaction.fields.getTextInputValue("server_type")?.trim() || "query";
      const ch   = interaction.fields.getTextInputValue("server_status_channel")?.trim();
      if (ip) await setGuildSetting(this.db, guildId, "game_server_config", JSON.stringify({ ip, port:parseInt(port)||27015, name, type }));
      if (ch) await setGuildSetting(this.db, guildId, "server_status_channel", ch);
      return interaction.reply({ content:"✅ Настройки сервера сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_music") {
      for (const f of ["music_dj_role","music_max_queue","music_default_volume","music_allowed_channel"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Настройки музыки сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_economy") {
      for (const f of ["economy_xp_rate","economy_daily_min","economy_daily_max","economy_work_min","economy_levelup_bonus"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Настройки экономики сохранены.", ephemeral:true });
    }

    if (id.startsWith("ctrl_modal_rules_")) {
      const type    = id.replace("ctrl_modal_rules_","");
      const title   = interaction.fields.getTextInputValue("title");
      const content = interaction.fields.getTextInputValue("content");
      await this.db.query("DELETE FROM server_rules WHERE guild_id=? AND type=?", [guildId, type]);
      await this.db.query("INSERT INTO server_rules (guild_id,type,title,content,sort_order) VALUES (?,?,?,?,0)",
        [guildId, type, title, content]);
      return interaction.reply({ content:`✅ Правила (${type}) сохранены.`, ephemeral:true });
    }

    if (id === "ctrl_modal_shop") {
      const name  = interaction.fields.getTextInputValue("item_name");
      const desc  = interaction.fields.getTextInputValue("item_desc");
      const price = parseInt(interaction.fields.getTextInputValue("item_price")) || 100;
      const role  = interaction.fields.getTextInputValue("item_role")?.trim() || null;
      await this.db.query("INSERT INTO eco_shop (guild_id,name,description,price,role_id) VALUES (?,?,?,?,?)",
        [guildId, name, desc, price, role]);
      return interaction.reply({ content:`✅ Товар **${name}** добавлен.`, ephemeral:true });
    }

    if (id === "ctrl_modal_ai_config") {
      const key   = interaction.fields.getTextInputValue("groq_key")?.trim();
      const limit = interaction.fields.getTextInputValue("ai_daily_limit")?.trim();
      const block = interaction.fields.getTextInputValue("ai_insult_block_min")?.trim();
      if (key)   await setGuildSetting(this.db, guildId, "groq_api_key", key);
      if (limit) await setGuildSetting(this.db, guildId, "ai_daily_limit", limit);
      if (block) await setGuildSetting(this.db, guildId, "ai_insult_block_min", block);
      return interaction.reply({ content:"✅ AI-конфиг сохранён.", ephemeral:true });
    }

    if (id === "ctrl_modal_ai_weights") {
      for (const f of ["weight_mat","weight_caps","weight_spam","weight_porn"]) {
        const v = interaction.fields.getTextInputValue(f)?.trim();
        if (v && !isNaN(v)) await setGuildSetting(this.db, guildId, f, v);
      }
      return interaction.reply({ content:"✅ Веса сохранены.", ephemeral:true });
    }

    if (id === "ctrl_modal_ai_prompt") {
      const prompt = interaction.fields.getTextInputValue("system_prompt");
      await setGuildSetting(this.db, guildId, "ai_system_prompt", prompt);
      return interaction.reply({ content:"✅ Промпт сохранён.", ephemeral:true });
    }

    if (id === "ctrl_modal_ai_limits") {
      const channelId = interaction.fields.getTextInputValue("ai_channel")?.trim();
      const limit     = interaction.fields.getTextInputValue("ai_daily_limit")?.trim();
      if (channelId) await setGuildSetting(this.db, guildId, "ai_channel", channelId);
      if (limit)     await setGuildSetting(this.db, guildId, "ai_daily_limit", limit);
      return interaction.reply({ content:"✅ Лимиты AI сохранены.", ephemeral:true });
    }
  }

  // ── AI / МОД суб-кнопки ──────────────────────────────────────
  async handleAiSubButton(interaction, guildId) {
    const id = interaction.customId;

    if (id === "ctrl_ai_config") {
      const modal = new ModalBuilder().setCustomId("ctrl_modal_ai_config").setTitle("🔑 AI — Конфигурация");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("groq_key").setLabel("Groq API ключ").setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder("gsk_...")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ai_daily_limit").setLabel("Лимит запросов в сутки").setStyle(TextInputStyle.Short).setPlaceholder("5")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ai_insult_block_min").setLabel("Блок за оскорбление AI (минут)").setStyle(TextInputStyle.Short).setPlaceholder("15"))
      );
      return interaction.showModal(modal);
    }
    if (id === "ctrl_ai_weights") {
      const modal = new ModalBuilder().setCustomId("ctrl_modal_ai_weights").setTitle("⚖️ Веса AUREX-AI");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("weight_mat").setLabel("Вес мата (0.1-3.0)").setStyle(TextInputStyle.Short).setPlaceholder("1.5")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("weight_caps").setLabel("Вес капса").setStyle(TextInputStyle.Short).setPlaceholder("0.5")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("weight_spam").setLabel("Вес спама").setStyle(TextInputStyle.Short).setPlaceholder("1.2")),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("weight_porn").setLabel("Вес NSFW").setStyle(TextInputStyle.Short).setPlaceholder("2.0"))
      );
      return interaction.showModal(modal);
    }
    if (id === "ctrl_ai_prompt") {
      const modal = new ModalBuilder().setCustomId("ctrl_modal_ai_prompt").setTitle("💬 Системный промпт");
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId("system_prompt").setLabel("Промпт для AUREX-AI").setStyle(TextInputStyle.Paragraph)
          .setPlaceholder("Ты — AUREX-9, умный помощник...").setRequired(true).setMaxLength(1800)
      ));
      return interaction.showModal(modal);
    }
    if (id === "ctrl_ai_limits") {
      const modal = new ModalBuilder().setCustomId("ctrl_modal_ai_limits").setTitle("🚫 Лимиты AI-чата");
      modal.addComponents(
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ai_channel").setLabel("ID канала (пусто = везде)").setStyle(TextInputStyle.Short).setRequired(false)),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("ai_daily_limit").setLabel("Лимит в сутки").setStyle(TextInputStyle.Short).setRequired(false))
      );
      return interaction.showModal(modal);
    }
    if (id === "ctrl_mod_actions") {
      const [rows] = await this.db.query(
        "SELECT mod_id,target_id,action,reason,created_at FROM mod_actions WHERE guild_id=? ORDER BY created_at DESC LIMIT 20",
        [guildId]);
      if (!rows.length) return interaction.reply({ content:"ℹ️ Нет записей.", ephemeral:true });
      const text = rows.map(r =>
        `<t:${Math.floor(r.created_at/1000)}:R> **${r.action}**: <@${r.mod_id}> → <@${r.target_id}> | ${r.reason||"—"}`
      ).join("\n").slice(0,3800);
      return interaction.reply({ embeds:[new EmbedBuilder()
        .setTitle("📜 Последние действия модераторов").setDescription(text).setColor(0x3399ff)
      ], ephemeral:true });
    }
    if (id === "ctrl_mod_reset") {
      await this.db.query("DELETE FROM mod_stats WHERE guild_id=?", [guildId]);
      return interaction.reply({ content:"✅ Статистика модераторов сброшена.", ephemeral:true });
    }
  }
}

// ═══════════════════════════════════════════════════════════════
//  ИНИЦИАЛИЗАЦИЯ БД (все таблицы панели)
// ═══════════════════════════════════════════════════════════════

async function initPanelDatabase(db) {
  const run = (sql, p=[]) => q(db, sql, p);

  await run(`CREATE TABLE IF NOT EXISTS panel_inventory (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL, user_id VARCHAR(32) NOT NULL,
    item VARCHAR(128) NOT NULL, amount INT DEFAULT 1, acquired_at BIGINT,
    INDEX idx_user (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_market (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL, seller VARCHAR(32) NOT NULL,
    item VARCHAR(128) NOT NULL, price INT DEFAULT 100, listed_at BIGINT,
    INDEX idx_guild (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_clans (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL, name VARCHAR(64) NOT NULL, owner VARCHAR(32) NOT NULL,
    role_id VARCHAR(64), coins INT DEFAULT 0, wins INT DEFAULT 0, losses INT DEFAULT 0, created_at BIGINT,
    UNIQUE KEY uniq_clan (guild_id, name), INDEX idx_guild (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_clan_members (
    guild_id VARCHAR(32) NOT NULL, clan_id INT NOT NULL, user_id VARCHAR(32) NOT NULL, rank VARCHAR(32) DEFAULT 'member',
    PRIMARY KEY (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_backgrounds (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(64) NOT NULL, price INT DEFAULT 1000, url TEXT, rarity VARCHAR(32) DEFAULT 'common'
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_xp_buffs (
    guild_id VARCHAR(32) NOT NULL, user_id VARCHAR(32) NOT NULL,
    multiplier FLOAT DEFAULT 2.0, expires_at BIGINT NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_verification (
    guild_id VARCHAR(32) NOT NULL, user_id VARCHAR(32) NOT NULL,
    verified_at BIGINT, method VARCHAR(32),
    PRIMARY KEY (guild_id, user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await run(`CREATE TABLE IF NOT EXISTS panel_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL, channel_id VARCHAR(64),
    reward INT DEFAULT 100, claimed_by VARCHAR(32), msg_id VARCHAR(64), created_at BIGINT,
    INDEX idx_guild (guild_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // Сид фонов
  const [bgs] = await run("SELECT id FROM panel_backgrounds LIMIT 1");
  if (!bgs.length) {
    await run(`INSERT INTO panel_backgrounds (name,price,url,rarity) VALUES
      ('Neon Red',    500,  'https://i.imgur.com/UaWcQe1.png', 'common'),
      ('Galaxy',     1500, 'https://i.imgur.com/3ZUrjUP.jpg',  'rare'),
      ('Cyber Blue', 2500, 'https://i.imgur.com/7b1mGgB.jpg',  'epic'),
      ('Aurora',     5000, 'https://i.imgur.com/sJEbCyZ.jpg',  'legendary')`);
  }

  console.log("✅ AUREX-9 Panel — таблицы инициализированы");
}

// ─── ЭКСПОРТ ─────────────────────────────────────────────────
module.exports = {
  // Класс
  ControlPanel,
  // Инициализация
  initPanelDatabase,
  // Деплой
  deployMainPanel,
  sendVerificationPanel,
  // Экономика
  addMessageXP,
  showProfile,
  showBalance,
  claimDaily,
  doWork,
  openCase,
  showTop,
  showBgShop,
  buyBackground,
  showInventory,
  showMarket,
  buyMarketItem,
  buyXPBuff,
  // Кланы
  createClan,
  showClan,
  // Дуэль
  duelChallenge,
  handleDuelAccept,
  // Статистика
  showServerStats,
  showModControl,
  showAurexStats,
  toggleSetting,
  // Защита
  checkAntiRaid,
  handleVerification,
  // Авто-системы
  startAutoEvents,
  startClanWars,
};
