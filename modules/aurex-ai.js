// modules/aurex-ai.js — AUREX-9 v3.0 | ИИ анализатор + Groq LLM

const Groq = require("groq-sdk");

const GROQ_API_KEY = "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";

let groqClient = null;

// ── СЛОВАРИ ─────────────────────────────────────────────────────
const MAT_WORDS = [
  "хуй","хуе","хуя","хуи","хуйн","пизд","пизда","пизде","пизду","пиздюк","пиздёж",
  "еб","еба","ебу","ебал","ебать","ебан","ебнут","нахуй","нахер","нахрен",
  "уеб","уёб","уебан","заеб","заёб","долбоеб","гандон","бляд","бля",
  "сука","сучка","мразь","мудак","пидор","пидар","шлюх","шлюха","тварь",
  "ублюдок","гнида","чмо","fuck","shit","bitch","cunt","nigger","faggot",
];

const PORN_WORDS = [
  "порно","секс видео","nsfw","xxx","onlyfans","nudes","nude","голая",
  "порнуха","porn","hentai","18+","18 плюс",
];

const SPAM_PATTERNS = [
  /(.)\1{8,}/,
  /(https?:\/\/\S+\s*){3,}/,
  /discord\.gg\/\S+/i,
  /@everyone|@here/,
];

const SUSPICIOUS_DOMAINS = [
  "discord-gift","discordnitro","nitrofree","steamgift","free-nitro",
  "nitro-drop","giveaway-nitro","claim-nitro",
];

const LEET = { "0":"о","3":"е","4":"а","1":"л","@":"а","$":"с","!":"и","|":"и","*":"" };

// ── НОРМАЛИЗАЦИЯ ─────────────────────────────────────────────────
function normalize(text) {
  let s = text.toLowerCase();
  s = s.split("").map(c => LEET[c] || c).join("");
  s = s.replace(/[^\w\sа-яё]/g, "");
  return s;
}

// ── АНАЛИЗ ───────────────────────────────────────────────────────
function analyze(text) {
  if (!text || typeof text !== "string") return { mat:false, caps:false, spam:false, porn:false, invite:false, score:0 };

  const lower  = text.toLowerCase();
  const norm   = normalize(text);

  // Мат
  const mat = MAT_WORDS.some(w => norm.includes(w));

  // Капс
  const letters = text.match(/[a-zа-яё]/gi) || [];
  const upper   = letters.filter(l => l !== l.toLowerCase()).length;
  const caps    = letters.length >= 6 && (upper / letters.length) > 0.7;

  // Спам
  const spam = SPAM_PATTERNS.some(p => p.test(text)) ||
    (() => {
      const words = lower.split(/\s+/);
      const freq  = {};
      for (const w of words) { freq[w] = (freq[w]||0)+1; if (freq[w] > 6) return true; }
      return words.length > 80;
    })();

  // NSFW
  const porn = PORN_WORDS.some(w => lower.includes(w));

  // Инвайт
  const invite = /discord\.gg\/\S+|discordapp\.com\/invite\/\S+/i.test(text);

  // Подозрительные ссылки
  const suspiciousLink = SUSPICIOUS_DOMAINS.some(d => lower.includes(d));

  const score =
    (mat  ? 1.5 : 0) + (caps ? 0.5 : 0) + (spam ? 1.2 : 0) +
    (porn ? 2.0 : 0) + (invite ? 1.8 : 0) + (suspiciousLink ? 2.0 : 0);

  return { mat, caps, spam, porn, invite, suspiciousLink, score };
}

// ── GROQ AI ОТВЕТ ────────────────────────────────────────────────
async function aiReply(message, systemPrompt, guildName, guildRules) {
  if (!groqClient) return null;
  try {
    const sysContent = systemPrompt ||
      `Ты — AUREX-9, умный помощник-администратор сервера "${guildName || "Discord"}". 
Ты вежливый, профессиональный, строгий. Отвечаешь кратко, по делу, на русском языке.
${guildRules ? `\nПравила сервера:\n${guildRules}` : ""}`;

    const res = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: sysContent },
        { role: "user",   content: `${message.author?.username || "User"}: ${message.content}` }
      ],
      temperature: 0.5,
      max_tokens:  200,
    });
    return res.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    console.error("[AUREX-AI] Groq error:", e.message);
    return null;
  }
}

// ── GROQ МОДЕРАЦИЯ (анализ сообщения через LLM) ──────────────────
async function aiModerate(text) {
  if (!groqClient) return null;
  try {
    const res = await groqClient.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content: `Проверь это сообщение на нарушения: нецензурная лексика, угрозы, спам, NSFW.
Ответь ТОЛЬКО JSON: {"violation": true/false, "type": "mat/spam/nsfw/threat/none", "confidence": 0.0-1.0}
Сообщение: "${text.slice(0,500)}"`
      }],
      temperature: 0,
      max_tokens: 60,
    });
    const raw = res.choices?.[0]?.message?.content || "{}";
    const clean = raw.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch { return null; }
}

function initGroq(apiKey) {
  const key = apiKey || GROQ_API_KEY;
  groqClient = new Groq({ apiKey: key });
  console.log("[AUREX-AI] Groq инициализирован");
}

function getGroq() { return groqClient; }

module.exports = { analyze, aiReply, aiModerate, initGroq, getGroq };
