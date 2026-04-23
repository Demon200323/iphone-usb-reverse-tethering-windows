// modules/music.js — AUREX-9 v3.0 | Музыкальная система TGD 5.2 Smooth+
const {
  joinVoiceChannel, createAudioPlayer, createAudioResource,
  AudioPlayerStatus, NoSubscriberBehavior, StreamType,
  VoiceConnectionStatus, entersState
} = require("@discordjs/voice");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require("discord.js");
const { spawn } = require("child_process");
const ytSearch  = require("yt-search");
const path      = require("path");
const fs        = require("fs");

const queues = new Map(); // guildId -> queue

// ── ВСПОМОГАТЕЛЬНЫЕ ──────────────────────────────────────────────
function getYtdlpPath() {
  const local = path.join(__dirname, "..", "bin", "yt-dlp");
  return fs.existsSync(local) ? local : "yt-dlp";
}

async function resolveSong(query, requester) {
  if (/^https?:\/\//i.test(query)) {
    return { title:"🔗 Прямая ссылка", url:query, thumbnail:null, duration:0, requester };
  }
  try {
    const res = await ytSearch(query);
    if (!res.videos.length) return null;
    const v = res.videos[0];
    return { title:v.title, url:v.url, thumbnail:v.thumbnail, duration:v.seconds||180, requester };
  } catch { return null; }
}

// ── ВОСПРОИЗВЕДЕНИЕ ──────────────────────────────────────────────
async function playSong(guildId, client) {
  const q = queues.get(guildId);
  if (!q || !q.songs.length) return cleanup(guildId);

  const song = q.songs[0];
  try {
    const ytdlpPath = getYtdlpPath();
    const ytdlp = spawn(ytdlpPath, [
      "-o", "-", "-f", "bestaudio[ext=m4a]/bestaudio/best",
      "--no-playlist", "--quiet", "--no-warnings", song.url
    ], { stdio: ["ignore","pipe","pipe"] });

    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
      "-af", `volume=${q.volume}`,
      "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"
    ], { stdio: ["pipe","pipe","pipe"], windowsHide: true });

    ytdlp.stderr?.on("data", d => console.error("[ytdlp stderr]", d.toString().trim()));
    ffmpeg.stderr?.on("data", d => console.error("[ffmpeg stderr]", d.toString().trim()));

    ytdlp.stdout.pipe(ffmpeg.stdin);
    console.log("[music] pipe установлен, yt-dlp → ffmpeg");

    ytdlp.on("error", (e) => { console.error("[music:ytdlp error]", e.message); nextSong(guildId, client); });
    ffmpeg.on("error", (e) => { console.error("[music:ffmpeg error]", e.message); nextSong(guildId, client); });
    ytdlp.on("close", (code) => console.log(`[music:ytdlp] exit code: ${code}`));
    ffmpeg.on("close", (code) => console.log(`[music:ffmpeg] exit code: ${code}`));
    ffmpeg.stdout.once("data", () => console.log("[music:ffmpeg] ✅ первые аудиоданные получены"));

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
    resource.volume?.setVolume(q.volume);

    console.log("[music] вызываем player.play(), текущий статус:", q.player.state.status);
    q.player.play(resource);
    q.currentResource = resource;

    if (q.nowPlayingMsg) await q.nowPlayingMsg.delete().catch(() => {});

    const embed = new EmbedBuilder()
      .setTitle("▶️ Сейчас играет")
      .setDescription(`**[${song.title}](${song.url})**`)
      .setColor(0x1db954)
      .addFields(
        { name:"⏱ Длительность", value: song.duration ? `${Math.floor(song.duration/60)}:${String(song.duration%60).padStart(2,"0")}` : "—", inline:true },
        { name:"🎵 В очереди",   value: String(Math.max(0, q.songs.length-1)), inline:true },
        { name:"🔁 Loop",        value: q.loop ? "✅" : "❌", inline:true }
      )
      .setFooter({ text:`Запросил: ${song.requester}` }).setTimestamp();
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

    q.nowPlayingMsg = await q.textChannel.send({ embeds:[embed], components:[row1,row2] });

    // ✅ ФИКС #2: если duration=0 (прямая ссылка), коллектор жил только 60 сек.
    // Теперь минимум 10 минут (600 сек) если длительность неизвестна.
    const collectorTime = ((song.duration || 600) + 60) * 1000;
    const collector = q.nowPlayingMsg.createMessageComponentCollector({ componentType: ComponentType.Button, time: collectorTime });

    collector.on("collect", async i => {
      await i.deferUpdate().catch(()=>{});
      const qr = queues.get(guildId);
      if (!qr) return;
      switch (i.customId) {
        case "music_pause":    qr.player.pause(); break;
        case "music_resume":   qr.player.unpause(); break;
        case "music_skip":     qr.player.stop(); break;
        case "music_stop":     cleanup(guildId); break;
        case "music_loop":     qr.loop = !qr.loop; break;
        case "music_vol_up":   qr.volume = Math.min(qr.volume + 0.1, 2); qr.currentResource?.volume?.setVolume(qr.volume); break;
        case "music_vol_down": qr.volume = Math.max(qr.volume - 0.1, 0); qr.currentResource?.volume?.setVolume(qr.volume); break;
        case "music_queue_show": {
          const songs = qr.songs.map((s,i)=>`${i===0?"▶️":`${i}.`} ${s.title}`).join("\n").slice(0,1900);
          await i.followUp({ content: `📋 **Очередь:**\n${songs||"Пусто"}`, flags: 64 }).catch(()=>{});
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
// ✅ ФИКС #3: принимаем db чтобы читать music_default_volume из настроек
async function handlePlay(interaction, db) {
  const vc = interaction.member.voice.channel;
  if (!vc) return interaction.reply({ content:"❌ Зайдите в голосовой канал", flags: 64 });

  const query = interaction.options.getString("запрос").trim();
  await interaction.deferReply({ flags: 64 });

  const song = await resolveSong(query, interaction.user.tag);
  if (!song) return interaction.editReply("❌ Трек не найден.");

  const guildId = interaction.guild.id;
  const client  = interaction.client;
  let q = queues.get(guildId);

  if (!q) {
    const conn = joinVoiceChannel({
      channelId: vc.id, guildId,
      adapterCreator: interaction.guild.voiceAdapterCreator,
      selfDeaf: true
    });

    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5000)
        ]);
      } catch { cleanup(guildId); }
    });

    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    conn.subscribe(player);

    // ✅ ФИКС #1: передаём client в nextSong, иначе следующий трек не играл
    player.on(AudioPlayerStatus.Idle, () => nextSong(guildId, client));
    player.on("error", () => nextSong(guildId, client));

    // ✅ ФИКС #3: читаем громкость по умолчанию из настроек сервера
    let defaultVolume = 0.5;
    if (db) {
      try {
        const [[row]] = await db.query(
          "SELECT value FROM guild_settings WHERE guild_id=? AND key=?",
          [guildId, "music_default_volume"]
        );
        if (row?.value) defaultVolume = Math.max(0, Math.min(200, parseInt(row.value))) / 100;
      } catch { /* если таблица недоступна — используем 0.5 */ }
    }

    q = { conn, player, songs:[], volume:defaultVolume, loop:false, textChannel:interaction.channel, nowPlayingMsg:null, currentResource:null };
    queues.set(guildId, q);

    // ✅ Ждём Ready — без этого player.play() уходит в пустоту
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 10_000);
      console.log("[music] голосовое соединение Ready ✅");
    } catch {
      console.error("[music] соединение не стало Ready за 10 сек");
      cleanup(guildId);
      return interaction.editReply("❌ Не удалось подключиться к голосовому каналу.");
    }
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
  if (!q?.player) return interaction.reply({ content:"❌ Музыка не играет.", flags: 64 });
  switch (type) {
    case "pause":  q.player.pause(); break;
    case "resume": q.player.unpause(); break;
    case "skip":   q.player.stop(); break;
    case "stop":   cleanup(interaction.guild.id); break;
    case "loop":   q.loop = !q.loop; break;
  }
  return interaction.reply({ content:`✅ ${type}`, flags: 64 });
}

function handleVolume(interaction) {
  const q = queues.get(interaction.guild.id);
  if (!q) return interaction.reply({ content:"❌ Музыка не играет.", flags: 64 });
  const v = Math.max(0, Math.min(200, interaction.options.getInteger("громкость")));
  q.volume = v / 100;
  q.currentResource?.volume?.setVolume(q.volume);
  return interaction.reply({ content:`🔊 Громкость: **${v}%**`, flags: 64 });
}

function handleQueue(interaction) {
  const q = queues.get(interaction.guild.id);
  if (!q?.songs.length) return interaction.reply({ content:"🎵 Очередь пуста.", flags: 64 });
  const text = q.songs.map((s,i)=>`${i===0?"▶️":`${i}.`} ${s.title} — *${s.requester}*`).join("\n").slice(0,1900);
  return interaction.reply({ embeds:[new EmbedBuilder().setTitle("📋 Очередь воспроизведения").setDescription(text).setColor(0x1db954)], flags: 64 });
}

module.exports = { handlePlay, handleControl, handleVolume, handleQueue, cleanup, queues };