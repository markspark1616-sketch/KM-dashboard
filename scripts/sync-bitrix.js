/**
 * scripts/sync-bitrix.js
 *
 * Логика:
 * 1. Находит SOURCE_ID источника "Victory парсинг".
 * 2. Автоматически находит коды кастомных полей по их названию (title),
 *    чтобы не хардкодить UF_CRM_XXXX руками.
 * 3. При первом запуске тянет ВСЕ лиды/сделки с 01.01.2026.
 *    При последующих — только те, что ИЗМЕНИЛИСЬ с последнего запуска
 *    (по DATE_MODIFY), даже если созданы давно — это нужно, чтобы у старого
 *    лида, который наконец "Пришёл", статус обновился и в дне его создания.
 * 4. Раскладывает каждую запись по дню создания (DATE_CREATE) и городу,
 *    сохраняя НЕ агрегаты, а сырые записи {id: статус/данные} — это
 *    позволяет точечно обновлять только изменившиеся записи, а агрегаты
 *    (счётчики) дашборд считает уже сам на лету из этих записей.
 * 5. Пишет результат в data/months/YYYY-MM.json (по одному файлу на месяц)
 *    и data/meta.json (справочники + курсор последней синхронизации).
 */

const fs = require("fs");
const path = require("path");
const { resolveCityFromSiteField, DEAL_CITY_HINT_LIST } = require("./city-map");

const SOURCE_NAME = process.env.BITRIX_SOURCE_NAME || "Victory парсинг";
const WEBHOOK_URL = process.env.BITRIX_WEBHOOK_URL;
const HISTORY_START = "2026-01-01T00:00:00";
// небольшой нахлёст назад, чтобы не потерять записи из-за рассинхрона часов
const CURSOR_OVERLAP_MINUTES = 10;

const DATA_DIR = path.join(__dirname, "..", "data");
const MONTHS_DIR = path.join(DATA_DIR, "months");
const META_PATH = path.join(DATA_DIR, "meta.json");

if (!WEBHOOK_URL) {
  console.error("ОШИБКА: не задана переменная окружения BITRIX_WEBHOOK_URL");
  process.exit(1);
}

// Названия кастомных полей — как они выглядят в интерфейсе Bitrix24.
// Коды полей (UF_CRM_...) находятся автоматически, см. discoverFieldCode().
const FIELD_TITLES = {
  leadSiteInfo: "Дополнительно об источнике",
  leadJunkReason: "Причина брака",
  leadRefusalReason: "Причина условного отказа",
  leadLowQualityReason: "Причина некачественного лида",
  dealPlanSum: "Сумма согласованного плана лечения со скидкой",
};

// Статусы лидов, которые считаются "Брак" — из них же собираем причины брака
const JUNK_STATUS_NAMES = ["Некачественный лид", "Не учитываем", "Условный отказ"];
const PCP_STATUS_NAMES = ["Не записан", "Отменил запись", "Записан", "Подтверждён на завтра", "Подтвержден на сегодня", "Пришёл"];
const BOOKED_STATUS_NAMES = ["Отменил запись", "Записан", "Подтверждён на завтра", "Подтвержден на сегодня", "Пришёл"];
const ACTIVE_BOOKED_STATUS_NAMES = ["Записан", "Подтверждён на завтра", "Подтвержден на сегодня"];
const ARRIVED_STATUS_NAMES = ["Пришёл"];
const NOANSWER_STATUS_NAMES = ["Недозвон"];

// ---------------------------------------------------------------------------

async function callMethod(method, params = {}) {
  const url = `${WEBHOOK_URL.replace(/\/$/, "")}/${method}.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bitrix24 API ${method} вернул ${res.status}: ${text}`);
  }
  const json = await res.json();
  if (json.error) {
    throw new Error(`Bitrix24 API ${method} ошибка: ${json.error_description || json.error}`);
  }
  return json;
}

async function fetchAll(method, params) {
  let start = 0;
  let all = [];
  while (true) {
    const json = await callMethod(method, { ...params, start });
    all = all.concat(json.result || []);
    if (typeof json.next === "number") {
      start = json.next;
    } else {
      break;
    }
  }
  return all;
}

function normalize(str) {
  return (str || "").trim().toLowerCase();
}

async function resolveSourceId(name) {
  const json = await callMethod("crm.status.list", {
    filter: { ENTITY_ID: "SOURCE" },
    select: ["STATUS_ID", "NAME"],
  });
  const target = normalize(name);
  const match = (json.result || []).find((row) => normalize(row.NAME) === target);
  if (!match) {
    const available = (json.result || []).map((r) => r.NAME).join(", ");
    throw new Error(`Источник "${name}" не найден. Доступные источники: ${available}`);
  }
  return match.STATUS_ID;
}

/** Находит код кастомного поля (UF_CRM_XXXX) по его названию в интерфейсе */
async function discoverFieldCode(entityFieldsMethod, title) {
  const json = await callMethod(entityFieldsMethod, {});
  const target = normalize(title);
  for (const [code, def] of Object.entries(json.result || {})) {
    if (def && typeof def === "object" && normalize(def.title) === target) {
      return code;
    }
  }
  console.warn(`⚠ Поле "${title}" не найдено через ${entityFieldsMethod} — будет пустым`);
  return null;
}

async function fetchLeadStatusNames() {
  const json = await callMethod("crm.status.list", {
    filter: { ENTITY_ID: "STATUS" },
    select: ["STATUS_ID", "NAME"],
  });
  const map = {};
  const byName = {};
  (json.result || []).forEach((row) => { map[row.STATUS_ID] = row.NAME; byName[normalize(row.NAME)] = row.STATUS_ID; });
  return { map, byName };
}

/** Строит карту STAGE_ID -> {name, semantics} по всем воронкам сделок + карту CATEGORY_ID -> название города */
async function fetchDealStageAndCategoryMaps() {
  const stageMap = {}; // STAGE_ID -> { name, semantics }
  const categoryNames = {}; // CATEGORY_ID -> имя воронки (используем как "город")

  const categories = await callMethod("crm.dealcategory.list", {});
  categoryNames["0"] = "Основная воронка";
  for (const cat of categories.result || []) {
    categoryNames[String(cat.ID)] = cat.NAME;
  }

  const entityIds = ["DEAL_STAGE", ...Object.keys(categoryNames).filter((id) => id !== "0").map((id) => `DEAL_STAGE_${id}`)];
  for (const entityId of entityIds) {
    try {
      const stages = await callMethod("crm.status.list", {
        filter: { ENTITY_ID: entityId },
        select: ["STATUS_ID", "NAME", "SEMANTICS"],
      });
      (stages.result || []).forEach((row) => {
        stageMap[row.STATUS_ID] = { name: row.NAME, semantics: row.SEMANTICS || null };
      });
    } catch (e) {
      console.warn(`Не удалось получить стадии для ${entityId}: ${e.message}`);
    }
  }
  return { stageMap, categoryNames };
}

function dayKey(dateStr) {
  // "2026-06-05T14:30:00+03:00" -> "2026-06-05"
  return (dateStr || "").slice(0, 10);
}

function monthKeyFromDay(day) {
  return day.slice(0, 7); // "2026-06"
}

function loadMonthFile(monthKey) {
  const filePath = path.join(MONTHS_DIR, `${monthKey}.json`);
  if (fs.existsSync(filePath)) {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
  return { month: monthKey, days: {} };
}

function saveMonthFile(monthKey, data) {
  fs.mkdirSync(MONTHS_DIR, { recursive: true });
  const filePath = path.join(MONTHS_DIR, `${monthKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data), "utf-8");
}

function ensureDay(monthData, day) {
  if (!monthData.days[day]) monthData.days[day] = { cities: {} };
  return monthData.days[day];
}

function ensureCity(dayData, city) {
  if (!dayData.cities[city]) dayData.cities[city] = { leads: {}, deals: {} };
  return dayData.cities[city];
}

async function main() {
  console.log("Ищу источник и справочники...");
  const sourceId = await resolveSourceId(SOURCE_NAME);
  const { map: leadStatusNames, byName: leadStatusIdByName } = await fetchLeadStatusNames();
  const { stageMap, categoryNames } = await fetchDealStageAndCategoryMaps();

  console.log("Ищу коды кастомных полей...");
  const leadSiteInfoCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadSiteInfo);
  const leadJunkReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadJunkReason);
  const leadRefusalReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadRefusalReason);
  const leadLowQualityReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadLowQualityReason);
  const dealPlanSumCode = await discoverFieldCode("crm.deal.fields", FIELD_TITLES.dealPlanSum);

  // --- meta / курсор последней синхронизации ---
  let meta = fs.existsSync(META_PATH)
    ? JSON.parse(fs.readFileSync(META_PATH, "utf-8"))
    : { lastSyncCursor: null, unmatchedSiteCodes: {} };

  const isFirstRun = !meta.lastSyncCursor;
  const syncStartedAt = new Date();

  const leadFilter = { SOURCE_ID: sourceId, ">=DATE_CREATE": HISTORY_START };
  const dealFilter = { SOURCE_ID: sourceId, ">=DATE_CREATE": HISTORY_START };
  if (!isFirstRun) {
    const cursorWithOverlap = new Date(new Date(meta.lastSyncCursor).getTime() - CURSOR_OVERLAP_MINUTES * 60000).toISOString();
    leadFilter[">=DATE_MODIFY"] = cursorWithOverlap;
    dealFilter[">=DATE_MODIFY"] = cursorWithOverlap;
  }

  console.log(isFirstRun ? "Первый запуск — тяну всю историю с 2026 года." : `Инкрементальная синхронизация с ${leadFilter[">=DATE_MODIFY"]}`);

  console.log("Загружаю лиды...");
  const leads = await fetchAll("crm.lead.list", {
    filter: leadFilter,
    select: ["ID", "STATUS_ID", "DATE_CREATE", leadSiteInfoCode, leadJunkReasonCode, leadRefusalReasonCode, leadLowQualityReasonCode].filter(Boolean),
  });
  console.log(`Загружено лидов (дельта): ${leads.length}`);

  console.log("Загружаю сделки...");
  const deals = await fetchAll("crm.deal.list", {
    filter: dealFilter,
    select: ["ID", "STAGE_ID", "CATEGORY_ID", "DATE_CREATE", "OPPORTUNITY", dealPlanSumCode].filter(Boolean),
  });
  console.log(`Загружено сделок (дельта): ${deals.length}`);

  // --- раскладываем лиды по дням/городам ---
  const touchedMonths = new Set();
  const monthCache = {};

  function getMonth(monthKey) {
    if (!monthCache[monthKey]) monthCache[monthKey] = loadMonthFile(monthKey);
    return monthCache[monthKey];
  }

  for (const lead of leads) {
    const day = dayKey(lead.DATE_CREATE);
    if (!day) continue;
    const monthKey = monthKeyFromDay(day);
    touchedMonths.add(monthKey);
    const monthData = getMonth(monthKey);
    const dayData = ensureDay(monthData, day);

    const siteFieldValue = leadSiteInfoCode ? lead[leadSiteInfoCode] : null;
    const { city, rawCode } = resolveCityFromSiteField(siteFieldValue);
    const cityKey = city || "_unmatched";
    if (!city && rawCode) {
      meta.unmatchedSiteCodes[rawCode] = (meta.unmatchedSiteCodes[rawCode] || 0) + 1;
    }
    const cityData = ensureCity(dayData, cityKey);

    const statusName = leadStatusNames[lead.STATUS_ID] || lead.STATUS_ID;
    let reason = null;
    if (statusName === "Некачественный лид") reason = (leadLowQualityReasonCode && lead[leadLowQualityReasonCode]) || null;
    else if (statusName === "Условный отказ") reason = (leadRefusalReasonCode && lead[leadRefusalReasonCode]) || null;
    else if (statusName === "Не учитываем") reason = (leadJunkReasonCode && lead[leadJunkReasonCode]) || null;

    cityData.leads[lead.ID] = { s: lead.STATUS_ID, r: reason };
  }

  // --- раскладываем сделки по дням/городам (город = воронка) ---
  for (const deal of deals) {
    const day = dayKey(deal.DATE_CREATE);
    if (!day) continue;
    const monthKey = monthKeyFromDay(day);
    touchedMonths.add(monthKey);
    const monthData = getMonth(monthKey);
    const dayData = ensureDay(monthData, day);

    const cityKey = categoryNames[String(deal.CATEGORY_ID)] || "_unmatched";
    const cityData = ensureCity(dayData, cityKey);

    cityData.deals[deal.ID] = {
      stage: deal.STAGE_ID,
      opportunity: parseFloat(deal.OPPORTUNITY) || 0,
      plan: dealPlanSumCode ? (parseFloat(deal[dealPlanSumCode]) || 0) : 0,
    };
  }

  for (const monthKey of touchedMonths) {
    saveMonthFile(monthKey, monthCache[monthKey]);
  }

  // --- обновляем meta.json ---
  meta.lastSyncCursor = syncStartedAt.toISOString();
  meta.sourceName = SOURCE_NAME;
  meta.sourceId = sourceId;
  meta.leadStatusNames = leadStatusNames;
  meta.dealStageMap = stageMap;
  meta.dealCategoryNames = categoryNames;
  meta.dealCityHintList = DEAL_CITY_HINT_LIST;
  meta.groups = {
    pcpStatusIds: PCP_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
    bookedStatusIds: BOOKED_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
    activeBookedStatusIds: ACTIVE_BOOKED_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
    arrivedStatusIds: ARRIVED_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
    junkStatusIds: JUNK_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
    noAnswerStatusIds: NOANSWER_STATUS_NAMES.map((n) => leadStatusIdByName[normalize(n)]).filter(Boolean),
  };
  meta.lastRunStats = {
    at: syncStartedAt.toISOString(),
    leadsFetched: leads.length,
    dealsFetched: deals.length,
    monthsTouched: [...touchedMonths],
    firstRun: isFirstRun,
  };

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2), "utf-8");

  console.log("Готово.");
  console.log(`Затронуто месяцев: ${[...touchedMonths].join(", ") || "нет"}`);
  const unmatched = Object.keys(meta.unmatchedSiteCodes || {});
  if (unmatched.length) {
    console.log(`⚠ Несопоставленные коды сайтов (см. data/meta.json → unmatchedSiteCodes): ${unmatched.join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Синхронизация упала с ошибкой:");
  console.error(err);
  process.exit(1);
});
