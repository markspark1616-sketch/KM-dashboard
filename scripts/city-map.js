/**
 * scripts/city-map.js
 *
 * Сопоставление кода сайта (из поля «Дополнительно об источнике» у ЛИДОВ,
 * формат "Сайт: Заявка от Victory_XXX") с человекочитаемым названием города.
 *
 * Подтверждено из присланных скриншотов:
 *   Victory_SPb          -> Санкт-Петербург
 *   Victory_TLT          -> Тольятти
 *   Victory_Kaliningrad  -> Калининград
 *   Victory_Krasnodar    -> Краснодар
 *   Victory_Tomsk        -> Томск
 *   Victory_Novokuznetsk -> Новокузнецк
 *
 * Остальные строки — ПРЕДПОЛОЖЕНИЕ по аналогии (названия городов совпадают
 * со списком воронок сделок). Проверьте после первого запуска: скрипт сам
 * соберёт список кодов, которые не нашли соответствия (data/meta.json →
 * unmatchedSiteCodes), и вы сможете дополнить эту таблицу.
 *
 * Ключ сравнивается без учёта регистра и подчёркиваний/пробелов.
 */

const CITY_MAP = {
  spb: "Санкт-Петербург",
  kaliningrad: "Калининград",
  krasnodar: "Краснодар",
  tomsk: "Томск",
  novokuznetsk: "Новокузнецк",
  tlt: "Тольятти", // Тольятти
  // --- ниже предположения, проверить после первого запуска ---
  kemerovo: "Кемерово",
  omsk: "Омск",
  perm: "Пермь",
  nn: "Нижний Новгород",
  nizhnynovgorod: "Нижний Новгород",
  samara: "Самара",
  krasnoyarsk: "Красноярск",
  barnaul: "Барнаул",
  ulanude: "Улан-Удэ",
  volgograd: "Волгоград",
  irkutsk: "Иркутск",
  rostov: "Ростов",
  novosibirsk: "Новосибирск", // у сделок это 2 отдельные воронки, у лидов различить нельзя
};

/** Список городов сделок (для справки / для UI) — как в воронках Bitrix24 */
const DEAL_CITY_HINT_LIST = [
  "Санкт-Петербург", "Нижний Новгород", "Ростов", "Краснодар", "Кемерово",
  "Калининград", "Новокузнецк", "Омск", "Пермь", "Новосибирск первичный ОП",
  "Новосибирск вторичный ОП", "НВСБ Отдел доп продаж", "Самара", "Красноярск",
  "Барнаул", "Тольятти", "Улан-Удэ", "Волгоград", "Иркутск", "Томск",
];

function normalizeCode(raw) {
  return (raw || "").toLowerCase().replace(/[^a-zа-яё0-9]/gi, "");
}

/**
 * Извлекает код сайта из значения поля «Дополнительно об источнике»
 * (обычно вида "Сайт: Заявка от Victory_SPb") и возвращает название города,
 * либо null, если не удалось сопоставить.
 */
function resolveCityFromSiteField(fieldValue) {
  if (!fieldValue) return { city: null, rawCode: null };
  const match = String(fieldValue).match(/victory[_\s]?([a-zа-яё]+)/i);
  if (!match) return { city: null, rawCode: null };
  const rawCode = match[1];
  const key = normalizeCode(rawCode);
  return { city: CITY_MAP[key] || null, rawCode };
}

module.exports = { CITY_MAP, DEAL_CITY_HINT_LIST, resolveCityFromSiteField, normalizeCode };
