// modules/music.js — AUREX-9 v3.1 | play-dl edition
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, NoSubscriberBehavior,
  VoiceConnectionStatus, entersState
} = require("@discordjs/voice");
const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ComponentType
} = require("discord.js");
const play = require("play-dl");
const fs   = require("fs");
const path = require("path");

// Загружаем куки YouTube чтобы обойти блокировку по IP хостинга
(async () => {
  const cookiePath = path.join(__dirname, "..", "cookies.txt");
  if (fs.existsSync(cookiePath)) {
    try {
      const raw = fs.readFileSync(cookiePath, "utf8");
      const cookies = {};
      for (const line of raw.split("\n")) {
        if (line.startsWith("#") || !line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length >= 7) cookies[parts[5]] = parts[6].trim();
      }
      const cookieStr = Object.entries(cookies).map(([k,v]) => `${k}=${v}`).join("; ");
      await play.setToken({
        youtube: { cookie: cookieStr },
        useragent: ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"]
      });
      console.log("[music] YouTube куки загружены успешно");
    } catch (e) {
      console.warn("[music] Не удалось загрузить куки:", e.message);
    }
  } else {
    console.warn("[music] cookies.txt не найден — YouTube будет блокировать запросы с IP хостинга");
  }
})();


const queues = new Map(); // guildId -> queue

// ── ВСПОМОГАТЕЛЬНЫЕ ──────────────────────────────────────────────

async function resolveSong(query, requester) {
  try {
    // Прямая ссылка на YouTube
    if (/^https?:\/\//i.test(query)) {
      const info = await play.video_info(query);
      const v = info.video_details;
      return {
        title:     v.title || "🔗 Прямая ссылка",
        url:       v.url,
        thumbnail: v.thumbnails?.[0]?.url || null,
        duration:  v.durationInSec || 0,
        requester
      };
    }

    // Поиск по тексту
    const results = await play.search(query, { limit: 1, source: { youtube: "video" } });
    if (!results.length) return null;
    const v = results[0];
    const url = v.url?.startsWith("http") ? v.url : `https://www.youtube.com/watch?v=${v.id}`;
    console.log("[music:resolveSong] найден трек:", v.title, "| url:", url);
    return {
      title:     v.title,
      url,
      thumbnail: v.thumbnails?.[0]?.url || null,
      duration:  v.durationInSec || 180,
      requester
    };
  } catch (e) {
    console.error("[music:resolveSong]", e.message);
    return null;
  }
}

// ── ВОСПРОИЗВЕДЕНИЕ ──────────────────────────────────────────────

async function playSong(guildId, client) {
  const q = queues.get(guildId);
  if (!q || !q.songs.length) return cleanup(guildId);

  const song = q.songs[0];
  try {
    // play-dl отдаёт готовый стрим — ffmpeg и yt-dlp не нужны
    const stream = await play.stream(song.url, { quality: 2 });

    const resource = createAudioResource(stream.stream, {
      inputType:    stream.type,
      inlineVolume: true
    });
    resource.volume?.setVolume(q.volume);

    q.player.play(resource);
    q.currentResource = resource;
    console.log("[music] ▶️ play-dl stream запущен:", song.title);

    // Удаляем старое Now Playing сообщение
    if (q.nowPlayingMsg) await q.nowPlayingMsg.delete().catch(() => {});

    // Embed
    const durStr = song.duration
      ? `${Math.floor(song.duration / 60)}:${String(song.duration % 60).padStart(2, "0")}`
      : "—";

    const embed = new EmbedBuilder()
      .setTitle("▶️ Сейчас играет")
      .setDescription(`**[${song.title}](${song.url})**`)
      .setColor(0x1db954)
      .addFields(
        { name: "⏱ Длительность", value: durStr,                                   inline: true },
        { name: "🎵 В очереди",   value: String(Math.max(0, q.songs.length - 1)), inline: true },
        { name: "🔁 Loop",        value: q.loop ? "✅" : "❌",                     inline: true }
      )
      .setFooter({ text: `Запросил: ${song.requester}` })
      .setTimestamp();

    if (song.thumbnail) embed.setThumbnail(song.thumbnail);

    const row1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("music_pause").setLabel("⏸").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("music_resume").setLabel("▶️").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("music_skip").setLabel("⏭").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("music_stop").setLabel("⏹").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_loop").setLabel("🔁").setStyle(q.loop ? ButtonStyle.Success : ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("music_vol_up").setLabel("🔊+").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_vol_down").setLabel("🔉-").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("music_queue_show").setLabel("📋 Очередь").setStyle(ButtonStyle.Secondary)
    );

    q.nowPlayingMsg = await q.textChannel.send({ embeds: [embed], components: [row1, row2] });

    const collectorTime = ((song.duration || 600) + 60) * 1000;
    const collector = q.nowPlayingMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: collectorTime
    });

    collector.on("collect", async i => {
      await i.deferUpdate().catch(() => {});
      const qr = queues.get(guildId);
      if (!qr) return;

      switch (i.customId) {
        case "music_pause":    qr.player.pause(); break;
        case "music_resume":   qr.player.unpause(); break;
        case "music_skip":     qr.player.stop(); break;
        case "music_stop":     cleanup(guildId); break;
        case "music_loop":     qr.loop = !qr.loop; break;
        case "music_vol_up":
          qr.volume = Math.min(qr.volume + 0.1, 2);
          qr.currentResource?.volume?.setVolume(qr.volume);
          break;
        case "music_vol_down":
          qr.volume = Math.max(qr.volume - 0.1, 0);
          qr.currentResource?.volume?.setVolume(qr.volume);
          break;
        case "music_queue_show": {
          const songs = qr.songs
            .map((s, idx) => `${idx === 0 ? "▶️" : `${idx}.`} ${s.title}`)
            .join("\n")
            .slice(0, 1900);
          await i.followUp({ content: `📋 **Очередь:**\n${songs || "Пусто"}`, flags: 64 }).catch(() => {});
          break;
        }
      }
    });
  } catch (e) {
    console.error("[music:playSong]", e.message);
    nextSong(guildId, client);
  }
}

function nextSong(guildId, client) {
  const q = queues.get(guildId);
  if (!q) return;
  if (!q.loop) q.songs.shift();
  if (q.songs.length) playSong(guildId, client);
  else cleanup(guildId);
}

function cleanup(guildId) {
  const q = queues.get(guildId);
  if (!q) return;
  q.nowPlayingMsg?.delete().catch(() => {});
  q.player?.stop(true);
  try { q.conn?.destroy(); } catch {}
  queues.delete(guildId);
}

// ── КОМАНДЫ ──────────────────────────────────────────────────────

async function handlePlay(interaction, db) {
  const vc = interaction.member.voice.channel;
  if (!vc) return interaction.reply({ content: "❌ Зайдите в голосовой канал", flags: 64 });

  const query = interaction.options.getString("запрос").trim();
  await interaction.deferReply({ flags: 64 });

  const song = await resolveSong(query, interaction.user.tag);
  if (!song) return interaction.editReply("❌ Трек не найден.");

  const guildId = interaction.guild.id;
  const client  = interaction.client;
  let q = queues.get(guildId);

  if (!q) {
    const conn = joinVoiceChannel({
      channelId:      vc.id,
      guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf:       true,
      selfMute:       false,
    });

    conn.on("stateChange", (oldState, newState) => {
      console.log(`[music:conn] ${oldState.status} → ${newState.status}`);
    });

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch { cleanup(guildId); }
    });

    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    conn.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => nextSong(guildId, client));
    player.on("error", e => {
      console.error("[music:player error]", e.message);
      nextSong(guildId, client);
    });

    // Читаем громкость по умолчанию из БД
    let defaultVolume = 0.5;
    if (db) {
      try {
        const [[row]] = await db.query(
          "SELECT value FROM guild_settings WHERE guild_id=$1 AND key=$2",
          [guildId, "music_default_volume"]
        );
        if (row?.value) defaultVolume = Math.max(0, Math.min(200, parseInt(row.value))) / 100;
      } catch { /* используем 0.5 */ }
    }

    q = {
      conn,
      player,
      songs:          [],
      volume:         defaultVolume,
      loop:           false,
      textChannel:    interaction.channel,
      nowPlayingMsg:  null,
      currentResource: null
    };
    queues.set(guildId, q);

    conn.on("stateChange", (oldState, newState) => {
      console.log(`[music:conn] ${oldState.status} → ${newState.status}`);
    });

    // Ждём Ready, но если не дождались — всё равно пробуем играть.
    // На некоторых хостингах UDP медленный, но соединение всё равно работает.
    await entersState(conn, VoiceConnectionStatus.Ready, 30_000).catch(e => {
      console.warn("[music] Ready не получен за 30 сек, пробуем играть всё равно. Статус:", conn.state.status);
    });
  }

  q.songs.push(song);

  if (q.songs.length === 1) {
    await playSong(guildId, client);
    return interaction.editReply(`▶️ Воспроизводится: **${song.title}**`);
  }
  return interaction.editReply(`📥 Добавлено в очередь (#${q.songs.length}): **${song.title}**`);
}

function handleControl(interaction, type) {
  const q = queues.get(interaction.guild.id);
  if (!q?.player) return interaction.reply({ content: "❌ Музыка не играет.", flags: 64 });
  switch (type) {
    case "pause":  q.player.pause(); break;
    case "resume": q.player.unpause(); break;
    case "skip":   q.player.stop(); break;
    case "stop":   cleanup(interaction.guild.id); break;
    case "loop":   q.loop = !q.loop; break;
  }
  return interaction.reply({ content: `✅ ${type}`, flags: 64 });
}

function handleVolume(interaction) {
  const q = queues.get(interaction.guild.id);
  if (!q) return interaction.reply({ content: "❌ Музыка не играет.", flags: 64 });
  const v = Math.max(0, Math.min(200, interaction.options.getInteger("громкость")));
  q.volume = v / 100;
  q.currentResource?.volume?.setVolume(q.volume);
  return interaction.reply({ content: `🔊 Громкость: **${v}%**`, flags: 64 });
}

function handleQueue(interaction) {
  const q = queues.get(interaction.guild.id);
  if (!q?.songs.length) return interaction.reply({ content: "🎵 Очередь пуста.", flags: 64 });
  const text = q.songs
    .map((s, i) => `${i === 0 ? "▶️" : `${i}.`} ${s.title} — *${s.requester}*`)
    .join("\n")
    .slice(0, 1900);
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("📋 Очередь воспроизведения")
        .setDescription(text)
        .setColor(0x1db954)
    ],
    flags: 64
  });
}

module.exports = { handlePlay, handleControl, handleVolume, handleQueue, cleanup, queues };
