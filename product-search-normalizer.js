const COLOR_FORMS = new Map([
    ["черный", "черный"], ["черная", "черный"], ["черное", "черный"], ["черные", "черный"],
    ["чёрный", "черный"], ["чёрная", "черный"], ["чёрное", "черный"], ["чёрные", "черный"],
    ["белый", "белый"], ["белая", "белый"], ["белое", "белый"], ["белые", "белый"],
    ["серый", "серый"], ["серая", "серый"], ["серое", "серый"], ["серые", "серый"],
    ["красный", "красный"], ["красная", "красный"], ["синий", "синий"], ["синяя", "синий"],
]);

const WORD_FORMS = new Map([
    ["месяца", "месяц"], ["месяцев", "месяц"], ["мес", "месяц"],
    ["фискального", "фискальный"], ["фискальные", "фискальный"],
    ["накопителя", "накопитель"], ["накопители", "накопитель"],
    ["оператора", "оператор"], ["данные", "данных"],
]);

function baseNormalize(value) {
    return String(value || "").normalize("NFKC").toLowerCase().replace(/ё/gu, "е")
        .replace(/двадцать\s+семь/gu, "27")
        .replace(/(?:три|3)\s+год(?:а|ов)?/gu, "36 месяц")
        .replace(/[«»"'“”„]/gu, " ")
        .replace(/([а-яa-z])s*-s*(d)/giu, "$1-$2")
        .replace(/(d)s*-s*(d)/gu, "$1-$2")
        .replace(/[()[\]{};,/:+*\\|]/gu, " ")
        .replace(/(?<!\d)[.](?!\d)/gu, " ")
        .replace(/\s+/gu, " ").trim();
}

function extractModels(text) {
    const models = new Set();
    for (const match of text.matchAll(/(?<![а-яa-z0-9])фн\s*-?\s*((?:\d+[.,]\d+[а-я]?|\d+[а-я]))(?![а-яa-z0-9])/giu)) {
        models.add("фн-" + match[1].replace(",", ".").toLowerCase());
    }
    for (const match of text.matchAll(/(?<![а-яa-z0-9])(\d{1,3})\s*ф(?![а-яa-z0-9])/giu)) {
        models.add(match[1] + "ф");
    }
    return [...models];
}

function extractMonths(text) {
    const result = new Set();
    for (const match of text.matchAll(/(?<!\d)(\d{1,3})\s*(?:мес(?:яц(?:а|ев)?)?\.?)(?![а-я])/giu)) {
        result.add(Number(match[1]));
    }
    return [...result];
}

function extractColors(text) {
    const colors = new Set();
    if (/темно[ -]?сер(?:ый|ая|ое|ые)/iu.test(text)) colors.add("темно-серый");
    for (const word of text.split(/\s+/u)) {
        const color = COLOR_FORMS.get(word);
        if (color && !(color === "серый" && colors.has("темно-серый"))) colors.add(color);
    }
    return [...colors];
}

function expandSynonyms(text) {
    return text
        .replace(/(?<![а-яa-z0-9])фискальник(?:а|и|ов)?(?![а-яa-z0-9])/giu, "фискальный накопитель")
        .replace(/(?<![а-яa-z0-9])фн(?!\s*-?\s*\d+(?:[.,]\d+|[а-я]))(?![а-яa-z0-9])/giu, "фискальный накопитель")
        .replace(/фискальн(?:ая|ую|ой|ые|ых)?\s+касс(?:а|у|ы|е)/giu, "касса ккт фискальный регистратор")
        .replace(/(?<![а-яa-z0-9])касс(?:а|у|ы|е)(?![а-яa-z0-9])/giu, "касса ккт фискальный регистратор")
        .replace(/(?<![а-яa-z0-9])ккт(?![а-яa-z0-9])/giu, "касса ккт фискальный регистратор")
        .replace(/фискальн(?:ый|ого|ому|ым)?\s+регистратор(?:а|ы|ов)?/giu, "касса ккт фискальный регистратор")
        .replace(/(?<![а-яa-z0-9])офд(?![а-яa-z0-9])/giu, "офд оператор фискальных данных")
        .replace(/оператор(?:а|ы|ов)?\s+фискальн(?:ых|ые|ыми)?\s+данн(?:ых|ые|ыми)?/giu, "офд оператор фискальных данных");
}

const SERVICE_SUBTYPE_PATTERNS = [
    ["registration", /(?:перерегистр|регистрац|зарегистрир)/u],
    ["setup", /(?:настройк|настроит)/u],
    ["installation", /(?:установк|установит|(?<!де)монтаж)/u],
    ["repair", /(?:ремонт|отремонтир)/u],
    ["maintenance", /(?:техобслуж|обслуживан|сервисн\w*\s+обслуж)/u],
    ["consultation", /(?:консультац)/u],
    ["activation", /(?:активац|активир)/u],
    ["replacement", /(?:замен)/u],
    ["update", /(?:обновлен|обновит)/u],
    ["diagnostics", /(?:диагност)/u],
];

function detectServiceSubtypes(text, options = {}) {
    const detected = SERVICE_SUBTYPE_PATTERNS
        .filter(([, pattern]) => pattern.test(text))
        .map(([subtype]) => subtype);
    const genericService = /(?:работ\w*\s+специалист|услуг)/u.test(text);
    if (!detected.length && (genericService || options.isService)) return ["other_service"];
    return detected;
}

function analyzeProductText(value, options = {}) {
    const base = baseNormalize(value);
    const models = extractModels(base);
    if (!models.length) {
        const atolModel = base.match(/(?<![а-яa-z0-9])атол\s+(\d{1,3})(?![а-яa-z0-9])/iu);
        if (atolModel) models.push(atolModel[1] + "ф");
    }
    let months = extractMonths(base);
    const colors = extractColors(base);
    const withoutFn = /(?<![а-яa-z0-9])без\s+(?:фн|накопител\w*|фискальн\w*\s+накопител\w*)(?![а-яa-z0-9])/iu.test(base);
    const expanded = baseNormalize(expandSynonyms(base));
    const tokens = [...new Set(expanded.split(/\s+/u).filter(Boolean).map(token => WORD_FORMS.get(token) || token))];
    const tokenSet = new Set(tokens);
    const categories = [];
    if (!withoutFn && tokenSet.has("накопитель") && tokenSet.has("фискальный")) categories.push("fn");
    if (tokenSet.has("ккт") || (tokenSet.has("фискальный") && tokenSet.has("регистратор"))) categories.push("kkt");
    if (tokenSet.has("офд") || (tokenSet.has("оператор") && tokenSet.has("данных"))) categories.push("ofd");
    if (tokens.some(token => /^(?:блок|механизм|модернизац|термопринтер|термопечатающ|корпус|плата|комплект|запчаст|кабель|шлейф)/u.test(token))) categories.push("part");
    if (options.inferBareDuration && !months.length && (categories.includes("fn") || categories.includes("ofd"))) {
        months = [...new Set(tokens.filter(token => /^(?:15|36)$/u.test(token)).map(Number))];
    }
    const serviceSubtypes = detectServiceSubtypes(base, options);
    const serviceIntent = serviceSubtypes.length > 0
        || tokens.some(token => /^(?:работ|услуг|подключен)/u.test(token));
    const normalizedServiceSubtypes = serviceSubtypes.length
        ? serviceSubtypes
        : (serviceIntent || options.isService ? ["other_service"] : []);
    const hardwareIntent = !serviceIntent && (
        categories.includes("kkt")
        || tokens.some(token => /^(?:касса|аппарат|оборудован|регистратор)/u.test(token))
    );
    return {
        normalizedText: tokens.join(" "),
        tokens,
        models,
        attributes: {
            months,
            withoutFn,
            color: colors,
            categories,
            serviceIntent,
            serviceSubtype: normalizedServiceSubtypes[0] || null,
            serviceSubtypes: normalizedServiceSubtypes,
            hardwareIntent,
        },
    };
}

module.exports = { SERVICE_SUBTYPE_PATTERNS, baseNormalize, detectServiceSubtypes, analyzeProductText };
