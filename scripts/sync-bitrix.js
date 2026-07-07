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
// ВАЖНО: подтверждено реальной выгрузкой crm.lead.fields — поля называются именно так:
//   UF_CRM_1748008077 = "Причина некачественного лида" (статус "Некачественный лид")
//   UF_CRM_1755787390 = "Причина не учета +"            (статус "Не учитываем")
//   UF_CRM_1748280876 = "Причина условного отказа"      (статус "Условный отказ")
// Поля "Причина брака" в системе не существует — это было ошибочное предположение.
const FIELD_TITLES = {
  leadSiteInfo: "Дополнительно об источнике",
  leadNotCountedReason: "Причина не учета +",
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

function stripPunctuation(str) {
  return normalize(str).replace(/[():.,«»"'-]/g, "").replace(/\s+/g, " ").trim();
}

const fieldsCache = {};
async function getFieldsList(entityFieldsMethod) {
  if (!fieldsCache[entityFieldsMethod]) {
    const json = await callMethod(entityFieldsMethod, {});
    fieldsCache[entityFieldsMethod] = json.result || {};
  }
  return fieldsCache[entityFieldsMethod];
}

/** Возвращает все "человеческие" названия поля, которые встречаются в его описании.
 *  ВАЖНО: у кастомных полей (UF_CRM_...) свойство title обычно равно самому коду поля,
 *  а настоящее отображаемое название лежит в listLabel/formLabel/filterLabel. */
function fieldLabels(def) {
  if (!def || typeof def !== "object") return [];
  return [def.title, def.listLabel, def.formLabel, def.filterLabel].filter(Boolean);
}

/** Находит код кастомного поля (UF_CRM_XXXX) по его названию в интерфейсе.
 *  Проверяет title/listLabel/formLabel/filterLabel — сначала точное совпадение, затем без пунктуации.
 *  Намеренно НЕ делает нечёткий поиск по вхождению подстроки — это один раз уже привело
 *  к ложному совпадению (нашло системное поле OPPORTUNITY вместо нужного). */
async function discoverFieldCode(entityFieldsMethod, title) {
  const fields = await getFieldsList(entityFieldsMethod);
  const target = normalize(title);
  const targetStripped = stripPunctuation(title);

  for (const [code, def] of Object.entries(fields)) {
    if (fieldLabels(def).some((label) => normalize(label) === target)) return code;
  }
  for (const [code, def] of Object.entries(fields)) {
    if (fieldLabels(def).some((label) => stripPunctuation(label) === targetStripped)) return code;
  }

  console.warn(`⚠ Поле "${title}" не найдено через ${entityFieldsMethod} — будет пустым`);
  return null;
}

/** Возвращает всех кандидатов (для отладки), даже без совпадения. */
function findFieldCandidates(fields, title) {
  const targetStripped = stripPunctuation(title);
  const candidates = [];
  for (const [code, def] of Object.entries(fields)) {
    const labels = fieldLabels(def);
    if (labels.some((l) => stripPunctuation(l).includes(targetStripped.split(" ")[0]))) {
      candidates.push({ code, labels });
    }
  }
  return candidates;
}

/** Возвращает полный список полей {код: название} — для отладки в meta.json, если что-то не найдётся */
async function getDebugFieldList(entityFieldsMethod) {
  const fields = await getFieldsList(entityFieldsMethod);
  return Object.entries(fields)
    .filter(([, def]) => def && typeof def === "object" && fieldLabels(def).length)
    .map(([code, def]) => ({ code, title: def.title, listLabel: def.listLabel || null, type: def.type || null }));
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

/**
 * ID вариантов причин → текст. Захардкожено вручную, потому что у вебхука
 * нет доступа к API справочников (lists.element.get / iblock.element.get
 * стабильно возвращают ACCESS_DENIED даже с правом "Списки" — видимо, дело
 * в правах на конкретный список внутри Bitrix24, а не в скоупах вебхука).
 * Сопоставление получено вручную через фильтры в интерфейсе Bitrix24.
 * Если появится новая причина, которой нет в этой таблице — в дашборде
 * она отобразится просто как число (ID), это сигнал дополнить таблицу.
 */
const HARDCODED_REASON_MAPS = {
  // "Причина некачественного лида" (UF_CRM_1748008077, статус "Некачественный лид")
  1748008077: {
    "24821": "Дубль",
    "2380468": "Дубль подрядчика",
    "2203884": "Не актуально после 3х касаний для роботов",
    "2203886": "Не оставлял заявку после 3х касаний",
    "24824": "Не РФ",
    "2179214": "Не целевой регион",
    "2179241": "Недозвон в течение 10 дней",
    "24825": "Противопоказания",
    "24820": "Спам",
  },
  // "Причина условного отказа" (UF_CRM_1748280876, статус "Условный отказ")
  1748280876: {
    "2179352": "Нашёл другую клинику",
    "2179283": "Отказался от посещения стоматологии",
    "2203911": "Не хочет ехать (другой регион)",
    "3024466": "Отложенный спрос",
  },
  // "Причина не учета +" (UF_CRM_1755787390, статус "Не учитываем")
  1755787390: {
    "2296159": "Дубль самого себя",
    "2195208": "Наш пациент",
  },
};

function hardcodedMapFor(fieldCode) {
  // fieldCode выглядит как "UF_CRM_1748008077" — вытаскиваем числовую часть
  const match = String(fieldCode || "").match(/(\d+)$/);
  const key = match ? match[1] : null;
  return (key && HARDCODED_REASON_MAPS[key]) || null;
}

/** Строит карту ID->текст для полей-списков.
 *  Сначала пробует захардкоженную таблицу (см. выше — API к этим справочникам
 *  недоступен из-за прав в самом Bitrix24). Если для поля нет захардкоженной
 *  таблицы, на всякий случай пробует API (вдруг права когда-нибудь починят). */
async function buildEnumMap(fields, fieldCode) {
  const hardcoded = hardcodedMapFor(fieldCode);
  if (hardcoded) return { ...hardcoded };

  const map = {};
  const def = fields[fieldCode];
  if (!def) return map;

  if (Array.isArray(def.items)) {
    for (const item of def.items) map[String(item.ID)] = item.VALUE;
    return map;
  }

  const iblockId = def.settings && def.settings.IBLOCK_ID;
  if (def.type === "iblock_element" && iblockId) {
    try {
      const json = await callMethod("lists.element.get", {
        IBLOCK_TYPE_ID: "lists",
        IBLOCK_ID: iblockId,
      });
      for (const el of json.result || []) {
        map[String(el.ID)] = el.NAME;
      }
    } catch (e) {
      console.warn(`⚠ Нет захардкоженной таблицы и не удалось получить справочник (IBLOCK_ID=${iblockId}) для поля ${fieldCode} через API: ${e.message}`);
    }
  }
  return map;
}

/** Декодирует значение поля (может быть строкой, ID-строкой, массивом ID или массивом строк) в массив текстов */
function decodeFieldValue(rawValue, enumMap) {
  if (rawValue === null || rawValue === undefined || rawValue === "") return [];
  const values = Array.isArray(rawValue) ? rawValue : [rawValue];
  return values
    .map((v) => (enumMap && enumMap[String(v)] !== undefined ? enumMap[String(v)] : v))
    .map((v) => String(v).trim())
    .filter(Boolean);
}

async function main() {
  console.log("Ищу источник и справочники...");
  const sourceId = await resolveSourceId(SOURCE_NAME);
  const { map: leadStatusNames, byName: leadStatusIdByName } = await fetchLeadStatusNames();
  const { stageMap, categoryNames } = await fetchDealStageAndCategoryMaps();

  console.log("Ищу коды кастомных полей...");
  const leadSiteInfoCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadSiteInfo);
  const leadNotCountedReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadNotCountedReason);
  const leadRefusalReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadRefusalReason);
  const leadLowQualityReasonCode = await discoverFieldCode("crm.lead.fields", FIELD_TITLES.leadLowQualityReason);
  const dealPlanSumCode = await discoverFieldCode("crm.deal.fields", FIELD_TITLES.dealPlanSum);

  const debugLeadFields = await getDebugFieldList("crm.lead.fields");
  const debugDealFields = await getDebugFieldList("crm.deal.fields");

  const leadFieldsRaw = await getFieldsList("crm.lead.fields");
  const notCountedReasonEnumMap = leadNotCountedReasonCode ? await buildEnumMap(leadFieldsRaw, leadNotCountedReasonCode) : {};
  const refusalReasonEnumMap = leadRefusalReasonCode ? await buildEnumMap(leadFieldsRaw, leadRefusalReasonCode) : {};
  const lowQualityReasonEnumMap = leadLowQualityReasonCode ? await buildEnumMap(leadFieldsRaw, leadLowQualityReasonCode) : {};

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
    select: ["ID", "STATUS_ID", "DATE_CREATE", leadSiteInfoCode, leadNotCountedReasonCode, leadRefusalReasonCode, leadLowQualityReasonCode].filter(Boolean),
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
    if (!city) {
      if (rawCode) {
        meta.unmatchedSiteCodes[rawCode] = (meta.unmatchedSiteCodes[rawCode] || 0) + 1;
      } else {
        // поле не пустое, но не похоже на "Victory_XXX" вообще — сохраняем пример для диагностики
        meta.unrecognizedSiteFieldSamples = meta.unrecognizedSiteFieldSamples || [];
        const sample = siteFieldValue ? String(siteFieldValue) : "(пусто)";
        if (meta.unrecognizedSiteFieldSamples.length < 30 && !meta.unrecognizedSiteFieldSamples.includes(sample)) {
          meta.unrecognizedSiteFieldSamples.push(sample);
        }
      }
    }
    const cityData = ensureCity(dayData, cityKey);

    const statusName = leadStatusNames[lead.STATUS_ID] || lead.STATUS_ID;
    let reasons = [];
    // Соответствие подтверждено реальной выгрузкой crm.lead.fields (listLabel полей):
    // "Некачественный лид" -> поле "Причина некачественного лида"
    // "Не учитываем"       -> поле "Причина не учета +"
    // "Условный отказ"     -> поле "Причина условного отказа"
    if (statusName === "Некачественный лид") reasons = decodeFieldValue(leadLowQualityReasonCode && lead[leadLowQualityReasonCode], lowQualityReasonEnumMap);
    else if (statusName === "Условный отказ") reasons = decodeFieldValue(leadRefusalReasonCode && lead[leadRefusalReasonCode], refusalReasonEnumMap);
    else if (statusName === "Не учитываем") reasons = decodeFieldValue(leadNotCountedReasonCode && lead[leadNotCountedReasonCode], notCountedReasonEnumMap);

    cityData.leads[lead.ID] = { s: lead.STATUS_ID, r: reasons };
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
  meta.resolvedFieldCodes = {
    leadSiteInfoCode, leadNotCountedReasonCode, leadRefusalReasonCode, leadLowQualityReasonCode, dealPlanSumCode,
  };
  meta.debugAllLeadFields = debugLeadFields;
  meta.debugAllDealFields = debugDealFields;
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
