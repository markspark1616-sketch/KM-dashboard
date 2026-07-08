/**
 * scripts/send-telegram-report.js
 *
 * Формирует вечерний отчёт по сегодняшнему дню (сколько заявок/ПЦП/явок/договоров
 * пришло СЕГОДНЯ по каждому городу) и отправляет его в личный Telegram-чат.
 *
 * Запускается как отдельный шаг сразу после вечерней синхронизации (см. sync.yml).
 * Можно запустить и вручную: TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/send-telegram-report.js
 */

const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DATA_DIR = path.join(__dirname, "..", "data");
const META_PATH = path.join(DATA_DIR, "meta.json");
const MONTHS_DIR = path.join(DATA_DIR, "months");

// Те же исключённые категории, что и в дашборде — не показываем их в отчёте
const EXCLUDED_CITIES = new Set([
  "Основная воронка", "АI_лидогенерация", "NPS", "Дожим", "VIP-клиенты", "Жалоба (VIP)",
]);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("ОШИБКА: не заданы переменные окружения TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  process.exit(1);
}

function todayMSK() {
  // en-CA даёт формат YYYY-MM-DD напрямую
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (e) {
    return fallback;
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram API вернул ошибку: ${json.description}`);
  }
}

async function main() {
  const day = todayMSK();
  const monthKey = day.slice(0, 7);

  const meta = loadJSON(META_PATH, {});
  const monthData = loadJSON(path.join(MONTHS_DIR, `${monthKey}.json`), { days: {} });
  const dayData = (monthData.days || {})[day] || { cities: {} };

  const groups = meta.groups || {};
  const pcpSet = new Set(groups.pcpStatusIds || []);
  const arrivedSet = new Set(groups.arrivedStatusIds || []);
  const stageMap = meta.dealStageMap || {};

  const cityStats = {};

  for (const [city, cd] of Object.entries(dayData.cities || {})) {
    if (EXCLUDED_CITIES.has(city)) continue;
    const stat = cityStats[city] || { leads: 0, pcp: 0, arrived: 0, won: 0 };

    for (const lead of Object.values(cd.leads || {})) {
      stat.leads++;
      if (pcpSet.has(lead.s)) stat.pcp++;
      if (arrivedSet.has(lead.s)) stat.arrived++;
    }
    for (const deal of Object.values(cd.deals || {})) {
      const stageInfo = stageMap[deal.stage] || {};
      if (stageInfo.semantics === "S") stat.won++;
    }
    cityStats[city] = stat;
  }

  const cities = Object.keys(cityStats).sort((a, b) => cityStats[b].leads - cityStats[a].leads);

  const totals = { leads: 0, pcp: 0, arrived: 0, won: 0 };
  for (const c of cities) {
    totals.leads += cityStats[c].leads;
    totals.pcp += cityStats[c].pcp;
    totals.arrived += cityStats[c].arrived;
    totals.won += cityStats[c].won;
  }

  const dateLabel = new Date(`${day}T00:00:00`).toLocaleDateString("ru-RU", {
    day: "numeric", month: "long", year: "numeric",
  });

  const lines = [];
  lines.push(`<b>Victory парсинг — ${escapeHtml(dateLabel)}</b>`);
  lines.push("");

  if (cities.length === 0) {
    lines.push("Сегодня по заявкам пока пусто.");
  } else {
    for (const c of cities) {
      const s = cityStats[c];
      lines.push(`<b>${escapeHtml(c)}</b>: Заявки ${s.leads} · ПЦП ${s.pcp} · Явка ${s.arrived} · Договор ${s.won}`);
    }
    lines.push("");
    lines.push(`<b>Итого по всем городам</b>: Заявки ${totals.leads} · ПЦП ${totals.pcp} · Явка ${totals.arrived} · Договор ${totals.won}`);
  }

  const text = lines.join("\n");
  console.log("Текст сообщения:\n" + text);

  await sendTelegramMessage(text);
  console.log("Отправлено в Telegram.");
}

main().catch((err) => {
  console.error("Не удалось отправить отчёт в Telegram:");
  console.error(err);
  process.exit(1);
});
