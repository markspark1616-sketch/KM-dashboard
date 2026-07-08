/**
 * scripts/send-telegram-report.js
 *
 * Отправляет отчёт в Telegram. Тип отчёта задаётся переменной окружения REPORT_TYPE:
 *   today     — срез за сегодня "как есть" (шлётся вечером, после 18:00-синхронизации)
 *   yesterday — полный итог за вчера + сравнение с позавчера и с тем же днём прошлой недели
 *   week      — итог только что закончившейся недели (пн-вс) + сравнение с неделей до неё
 *   month     — итог только что закончившегося месяца + сравнение с предыдущим + % плана
 *
 * Запускается шагами в .github/workflows/sync.yml по расписанию.
 * Ручной запуск: REPORT_TYPE=today TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/send-telegram-report.js
 *
 * ВАЖНО: вся логика подсчёта продублирована в cloudflare-worker/telegram-bot.js для
 * мгновенных ответов на команды в чате — при изменении формул поправьте оба файла.
 */

const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const REPORT_TYPE = process.env.REPORT_TYPE || "today";

const DATA_DIR = path.join(__dirname, "..", "data");
const META_PATH = path.join(DATA_DIR, "meta.json");
const PLANS_PATH = path.join(DATA_DIR, "plans.json");
const MONTHS_DIR = path.join(DATA_DIR, "months");

const EXCLUDED_CITIES = new Set([
  "Основная воронка", "АI_лидогенерация", "NPS", "Дожим", "VIP-клиенты", "Жалоба (VIP)",
]);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("ОШИБКА: не заданы переменные окружения TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  process.exit(1);
}

/* ------------------------------ даты (МСК) ------------------------------ */

function todayMSK() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());
}
function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function monthKeyOf(day) { return day.slice(0, 7); }
function dayOfMonthOf(day) { return parseInt(day.slice(8, 10), 10); }
function daysInMonth(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function prevMonthKey(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
/** понедельник = 1 ... воскресенье = 7 */
function isoWeekday(day) {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
function mondayOf(day) { return addDays(day, -(isoWeekday(day) - 1)); }

const MONTHS_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_RU_NOM = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];

function formatDateLabel(day) {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS_RU[m - 1]} ${y}`;
}
function formatMonthLabel(monthKey) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${MONTHS_RU_NOM[m - 1]} ${y}`;
}

/* ------------------------------ загрузка данных ------------------------------ */

function loadJSON(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (e) { return fallback; }
}

const monthCache = {};
function loadMonth(monthKey) {
  if (!(monthKey in monthCache)) {
    monthCache[monthKey] = loadJSON(path.join(MONTHS_DIR, `${monthKey}.json`), { days: {} });
  }
  return monthCache[monthKey];
}

function getDayData(day) {
  const month = loadMonth(monthKeyOf(day));
  return (month.days || {})[day] || { cities: {} };
}

/* ------------------------------ подсчёт статистики ------------------------------ */

function emptyStat() { return { leads: 0, pcp: 0, booked: 0, arrived: 0, junk: 0, won: 0 }; }

function addDayIntoStats(cityStats, day, meta) {
  const groups = meta.groups || {};
  const pcpSet = new Set(groups.pcpStatusIds || []);
  const bookedSet = new Set(groups.bookedStatusIds || []);
  const arrivedSet = new Set(groups.arrivedStatusIds || []);
  const junkSet = new Set(groups.junkStatusIds || []);
  const stageMap = meta.dealStageMap || {};

  const dayData = getDayData(day);
  for (const [city, cd] of Object.entries(dayData.cities || {})) {
    if (EXCLUDED_CITIES.has(city)) continue;
    if (!cityStats[city]) cityStats[city] = emptyStat();
    const stat = cityStats[city];
    for (const lead of Object.values(cd.leads || {})) {
      stat.leads++;
      if (pcpSet.has(lead.s)) stat.pcp++;
      if (bookedSet.has(lead.s)) stat.booked++;
      if (arrivedSet.has(lead.s)) stat.arrived++;
      if (junkSet.has(lead.s)) stat.junk++;
    }
    for (const deal of Object.values(cd.deals || {})) {
      const stageInfo = stageMap[deal.stage] || {};
      if (stageInfo.semantics === "S") stat.won++;
    }
  }
}

/** Статистика по городам за один день */
function statsForDay(day, meta) {
  const cityStats = {};
  addDayIntoStats(cityStats, day, meta);
  return cityStats;
}

/** Статистика по городам, просуммированная за диапазон дней [fromDay, toDay] включительно */
function statsForRange(fromDay, toDay, meta) {
  const cityStats = {};
  let d = fromDay;
  while (d <= toDay) {
    addDayIntoStats(cityStats, d, meta);
    d = addDays(d, 1);
  }
  return cityStats;
}

function sumStats(cityStats) {
  const totals = emptyStat();
  for (const s of Object.values(cityStats)) {
    totals.leads += s.leads; totals.pcp += s.pcp; totals.booked += s.booked;
    totals.arrived += s.arrived; totals.junk += s.junk; totals.won += s.won;
  }
  return totals;
}

function totalLeadsOnly(fromDay, toDay, meta) {
  return sumStats(statsForRange(fromDay, toDay, meta)).leads;
}

/* ------------------------------ форматирование ------------------------------ */

function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function statLine(s) {
  return `Заявки: <b>${s.leads}</b>   ПЦП: <b>${s.pcp}</b>   Записи: <b>${s.booked}</b>   Явка: <b>${s.arrived}</b>   Договор: <b>${s.won}</b>`;
}
function cityBlocks(cityStats) {
  const cities = Object.keys(cityStats).sort((a, b) => cityStats[b].leads - cityStats[a].leads);
  const lines = [];
  for (const c of cities) {
    const s = cityStats[c];
    lines.push(`🏙 <b>${escapeHtml(c)}</b>`);
    lines.push(statLine(s));
    if (s.junk > 0) lines.push(`⚠️ Брак: <b>${s.junk}</b>`);
    lines.push("");
  }
  return { lines, cities };
}
function compareLine(label, current, previous) {
  const delta = current - previous;
  const pct = previous ? (delta / previous * 100) : (current > 0 ? 100 : 0);
  const arrow = delta > 0 ? "🔼" : delta < 0 ? "🔽" : "▪️";
  const sign = delta > 0 ? "+" : "";
  return `${arrow} ${label}: <b>${current}</b> (было ${previous}, ${sign}${delta}, ${sign}${pct.toFixed(1)}%)`;
}

/* ------------------------------ рекорд месяца (для "today") ------------------------------ */

function isRecordOfMonth(today, meta) {
  const monthKey = monthKeyOf(today);
  const monthData = loadMonth(monthKey);
  const dayOfMonth = dayOfMonthOf(today);
  let maxSoFar = -1;
  for (let d = 1; d < dayOfMonth; d++) {
    const dayStr = `${monthKey}-${String(d).padStart(2, "0")}`;
    const leads = sumStats(statsForDay(dayStr, meta)).leads;
    if (leads > maxSoFar) maxSoFar = leads;
  }
  const todayLeads = sumStats(statsForDay(today, meta)).leads;
  return maxSoFar >= 0 && todayLeads > maxSoFar && todayLeads > 0;
}

/* ------------------------------ планы ------------------------------ */

function planProgressLines(monthKey, cityStats, dayOfMonthElapsed, plans) {
  const monthPlans = plans[monthKey];
  if (!monthPlans || Object.keys(monthPlans).length === 0) return [];
  const totalDays = daysInMonth(monthKey);
  const lines = ["", "🎯 <b>Ход выполнения плана (заявки)</b>"];
  for (const [city, planValue] of Object.entries(monthPlans)) {
    const actual = (cityStats[city] || emptyStat()).leads;
    const pct = planValue ? (actual / planValue * 100) : 0;
    const projected = dayOfMonthElapsed ? Math.round(actual / dayOfMonthElapsed * totalDays) : actual;
    const projPct = planValue ? (projected / planValue * 100) : 0;
    lines.push(`${escapeHtml(city)}: ${actual}/${planValue} (${pct.toFixed(0)}%) · при текущем темпе ≈${projected} (${projPct.toFixed(0)}%)`);
  }
  return lines;
}

/* ------------------------------ сборка отчётов ------------------------------ */

function buildTodayReport(meta) {
  const today = todayMSK();
  const cityStats = statsForDay(today, meta);
  const totals = sumStats(cityStats);
  const { lines: cLines, cities } = cityBlocks(cityStats);

  const lines = [`📊 <b>Victory парсинг</b> — ${escapeHtml(formatDateLabel(today))}`, ""];
  if (cities.length === 0) {
    lines.push("Сегодня по заявкам пока пусто.");
    return lines.join("\n");
  }
  lines.push(...cLines);
  lines.push("━━━━━━━━━━━━━━━━━━━");
  lines.push("📈 <b>Итого по всем городам</b>");
  lines.push(statLine(totals));
  if (totals.junk > 0) lines.push(`⚠️ Брак: <b>${totals.junk}</b>`);

  if (isRecordOfMonth(today, meta)) {
    lines.push("");
    lines.push("🎉 <b>Рекорд месяца по заявкам!</b>");
  }
  return lines.join("\n");
}

function buildYesterdayReport(meta) {
  const today = todayMSK();
  const yesterday = addDays(today, -1);
  const dayBefore = addDays(today, -2);
  const sameDayLastWeek = addDays(today, -8);

  const cityStats = statsForDay(yesterday, meta);
  const totals = sumStats(cityStats);
  const { lines: cLines, cities } = cityBlocks(cityStats);

  const lines = [`🌅 <b>Victory парсинг — итоги за вчера</b>`, `🗓 ${escapeHtml(formatDateLabel(yesterday))}`, ""];
  if (cities.length === 0) {
    lines.push("Вчера по заявкам было пусто.");
    return lines.join("\n");
  }
  lines.push(...cLines);
  lines.push("━━━━━━━━━━━━━━━━━━━");
  lines.push("📈 <b>Итого по всем городам</b>");
  lines.push(statLine(totals));
  if (totals.junk > 0) lines.push(`⚠️ Брак: <b>${totals.junk}</b>`);

  const leadsDayBefore = totalLeadsOnly(dayBefore, dayBefore, meta);
  const leadsSameDayLastWeek = totalLeadsOnly(sameDayLastWeek, sameDayLastWeek, meta);
  lines.push("");
  lines.push("<b>Сравнение по заявкам:</b>");
  lines.push(compareLine("к позавчера", totals.leads, leadsDayBefore));
  lines.push(compareLine("к прошлой неделе (тот же день)", totals.leads, leadsSameDayLastWeek));

  return lines.join("\n");
}

function buildWeekReport(meta) {
  const today = todayMSK();
  const thisMonday = mondayOf(today);
  const lastWeekEnd = addDays(thisMonday, -1); // воскресенье только что закончившейся недели
  const lastWeekStart = addDays(lastWeekEnd, -6); // понедельник той недели
  const prevWeekEnd = addDays(lastWeekStart, -1);
  const prevWeekStart = addDays(prevWeekEnd, -6);

  const cityStats = statsForRange(lastWeekStart, lastWeekEnd, meta);
  const totals = sumStats(cityStats);
  const { lines: cLines, cities } = cityBlocks(cityStats);

  const lines = [
    `📅 <b>Victory парсинг — итоги недели</b>`,
    `${escapeHtml(formatDateLabel(lastWeekStart))} — ${escapeHtml(formatDateLabel(lastWeekEnd))}`,
    "",
  ];
  if (cities.length === 0) {
    lines.push("За эту неделю данных нет.");
    return lines.join("\n");
  }
  lines.push(...cLines);
  lines.push("━━━━━━━━━━━━━━━━━━━");
  lines.push("📈 <b>Итого за неделю</b>");
  lines.push(statLine(totals));
  if (totals.junk > 0) lines.push(`⚠️ Брак: <b>${totals.junk}</b>`);

  const prevWeekLeads = totalLeadsOnly(prevWeekStart, prevWeekEnd, meta);
  lines.push("");
  lines.push(compareLine("Заявки к прошлой неделе", totals.leads, prevWeekLeads));

  const plans = loadJSON(PLANS_PATH, {});
  const monthKey = monthKeyOf(lastWeekEnd);
  const monthToDateStats = statsForRange(`${monthKey}-01`, lastWeekEnd, meta);
  lines.push(...planProgressLines(monthKey, monthToDateStats, dayOfMonthOf(lastWeekEnd), plans));

  return lines.join("\n");
}

function buildMonthReport(meta) {
  const today = todayMSK();
  const thisMonthKey = monthKeyOf(today);
  const lastMonthKey = prevMonthKey(thisMonthKey);
  const lastMonthStart = `${lastMonthKey}-01`;
  const lastMonthEnd = `${lastMonthKey}-${String(daysInMonth(lastMonthKey)).padStart(2, "0")}`;
  const monthBeforeKey = prevMonthKey(lastMonthKey);
  const monthBeforeStart = `${monthBeforeKey}-01`;
  const monthBeforeEnd = `${monthBeforeKey}-${String(daysInMonth(monthBeforeKey)).padStart(2, "0")}`;

  const cityStats = statsForRange(lastMonthStart, lastMonthEnd, meta);
  const totals = sumStats(cityStats);
  const { lines: cLines, cities } = cityBlocks(cityStats);

  const lines = [`🗓 <b>Victory парсинг — итоги месяца</b>`, escapeHtml(formatMonthLabel(lastMonthKey)), ""];
  if (cities.length === 0) {
    lines.push("За этот месяц данных нет.");
    return lines.join("\n");
  }
  lines.push(...cLines);
  lines.push("━━━━━━━━━━━━━━━━━━━");
  lines.push("📈 <b>Итого за месяц</b>");
  lines.push(statLine(totals));
  if (totals.junk > 0) lines.push(`⚠️ Брак: <b>${totals.junk}</b>`);

  const monthBeforeLeads = totalLeadsOnly(monthBeforeStart, monthBeforeEnd, meta);
  lines.push("");
  lines.push(compareLine("Заявки к предыдущему месяцу", totals.leads, monthBeforeLeads));

  const plans = loadJSON(PLANS_PATH, {});
  const monthPlans = plans[lastMonthKey];
  if (monthPlans && Object.keys(monthPlans).length > 0) {
    lines.push("");
    lines.push("🎯 <b>Итог по плану (заявки)</b>");
    for (const [city, planValue] of Object.entries(monthPlans)) {
      const actual = (cityStats[city] || emptyStat()).leads;
      const pct = planValue ? (actual / planValue * 100) : 0;
      const mark = pct >= 100 ? "✅" : pct >= 80 ? "🟡" : "🔴";
      lines.push(`${mark} ${escapeHtml(city)}: ${actual}/${planValue} (${pct.toFixed(0)}%)`);
    }
  }

  return lines.join("\n");
}

/* ------------------------------ отправка ------------------------------ */

async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram API вернул ошибку: ${json.description}`);
}

async function main() {
  const meta = loadJSON(META_PATH, {});

  const builders = {
    today: buildTodayReport,
    yesterday: buildYesterdayReport,
    week: buildWeekReport,
    month: buildMonthReport,
  };
  const builder = builders[REPORT_TYPE];
  if (!builder) throw new Error(`Неизвестный REPORT_TYPE: ${REPORT_TYPE}`);

  const text = builder(meta);
  console.log(`Текст сообщения (${REPORT_TYPE}):\n` + text.replace(/<\/?b>/g, ""));

  await sendTelegramMessage(text);
  console.log("Отправлено в Telegram.");
}

main().catch((err) => {
  console.error("Не удалось отправить отчёт в Telegram:");
  console.error(err);
  process.exit(1);
});
