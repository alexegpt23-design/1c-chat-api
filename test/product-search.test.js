const { test } = require("node:test");
const assert = require("node:assert/strict");
const { analyzeProductText } = require("../product-search-normalizer");
const { buildSearchDocument, fetchProductCatalog, PRODUCT_FIELDS } = require("../product-catalog-sync");
const { scoreProduct, searchProducts } = require("../product-search-service");

function product(ref, name, extra = {}) {
    return buildSearchDocument({
        Ref_Key: ref.padStart(36, "0"), DataVersion: "v1", Code: extra.code || ref,
        Description: name, НаименованиеПолное: extra.fullName || name, Артикул: extra.article || "",
        ВидНоменклатуры_Key: "type", НоменклатурнаяГруппа_Key: "group", Parent_Key: "parent", Услуга: extra.service || false,
    });
}

const index = { products: [
    product("1", "Фискальный накопитель на 15 месяцев"),
    product("2", "Фискальный накопитель ФН-1.2 на 15 месяцев FERMA"),
    product("3", "Фискальный накопитель на 36 месяцев"),
    product("4", "Фискальный накопитель ФН-1.1М исп. (36 мес.)"),
    product("5", "Фискальный накопитель ФН-1.2 (36 мес.)"),
    product("6", "ККТ АТОЛ 30Ф. Темно-серый. Без ФН. USB"),
    product("7", "ККТ АТОЛ 30Ф+. Темно-серый. Без ФН. USB"),
    product("8", "Блок индикации для АТОЛ 11Ф/30Ф"),
    product("9", 'Фискальный регистратор "АТОЛ 27Ф" Без ФН Ethernet (черный)'),
    product("10", "Комплект модернизации АТОЛ 27Ф"),
    product("11", "Код активации ОФД на 36 месяцев"),
    product("12", "Код активации Промо тарифа (Астрал ОФД) на 36 месяцев"),
    product("13", "Сканер АТОЛ SB 2108 Plus черный", { code: "ИН-000777", article: "SKU-ABC-42" }),
    product("14", "Сканер АТОЛ SB 2108 Plus белый"),
] };

test("нормализатор сохраняет модели, сроки, без ФН и цвета", () => {
    const value = analyzeProductText("Касса АТОЛ 30Ф, чёрная, без ФН, срок 15 мес.");
    assert.deepEqual(value.models, ["30ф"]);
    assert.deepEqual(value.attributes.months, [15]);
    assert.equal(value.attributes.withoutFn, true);
    assert.deepEqual(value.attributes.color, ["черный"]);
    assert.ok(value.attributes.categories.includes("kkt"));
});

test("словарь раскрывает ФН, фискальник, кассу и ОФД", () => {
    for (const text of ["фн", "фискальник"]) assert.ok(analyzeProductText(text).tokens.includes("накопитель"));
    for (const text of ["касса", "ккт", "фискальный регистратор"]) assert.ok(analyzeProductText(text).attributes.categories.includes("kkt"));
    assert.ok(analyzeProductText("офд").attributes.categories.includes("ofd"));
});

for (const [query, decision] of [
    ["фн 15", "ambiguous"],
    ["фискальник 15 месяцев", "ambiguous"],
    ["фискальный накопитель на 36", "ambiguous"],
    ["атол 30ф", "ambiguous"],
    ["касса атол 27 черная без фн", "selected"],
    ["офд 36 месяцев", "ambiguous"],
]) {
    test("поиск: " + query, () => assert.equal(searchProducts(query, index).decision, decision));
}

test("запчасть АТОЛ 30Ф не выше самой ККТ", () => {
    const result = searchProducts("атол 30ф", index);
    assert.match(result.candidates[0].name, /^ККТ АТОЛ 30Ф/u);
    assert.ok(result.candidates.findIndex(item => item.name.startsWith("Блок")) > 0);
});

test("конфликт категорий ФН и ОФД получает строгий штраф", () => {
    const fn = scoreProduct("фн 15 месяцев", index.products[0]);
    const ofd = scoreProduct("фн 15 месяцев", product("21", "Код активации ОФД на 15 месяцев"));
    assert.ok(fn.score - ofd.score > 80);
    assert.ok(ofd.reasons.includes("category-conflict"));
});

test("конфликт срока 15 и 36 получает строгий штраф", () => {
    const fifteen = scoreProduct("фн 15 месяцев", index.products[0]);
    const thirtySix = scoreProduct("фн 15 месяцев", index.products[2]);
    assert.ok(fifteen.score - thirtySix.score > 100);
    assert.ok(thirtySix.reasons.includes("duration-conflict"));
});

test("модели 27Ф и 30Ф конфликтуют", () => {
    const right = scoreProduct("касса атол 27ф", index.products[8]);
    const wrong = scoreProduct("касса атол 27ф", index.products[5]);
    assert.ok(right.score - wrong.score > 100);
    assert.ok(wrong.reasons.includes("model-conflict"));
});

test("ФН-1.1М и ФН-1.2 различаются строго", () => {
    const right = scoreProduct("фн-1.1м 36 месяцев", index.products[3]);
    const wrong = scoreProduct("фн-1.1м 36 месяцев", index.products[4]);
    assert.ok(right.score - wrong.score > 100);
});

test("без ФН и цвет влияют сильнее обычного токена", () => {
    const black = scoreProduct("касса атол 27ф черная без фн", index.products[8]);
    const noAttributes = scoreProduct("касса атол 27ф черная без фн", product("20", "ККТ АТОЛ 27Ф"));
    const white = scoreProduct("сканер атол sb 2108 белый", index.products[13]);
    const wrongColor = scoreProduct("сканер атол sb 2108 белый", index.products[12]);
    assert.ok(black.score > noAttributes.score);
    assert.ok(white.score - wrongColor.score > 40);
});

test("точный код и артикул выбираются уверенно", () => {
    assert.equal(searchProducts("ИН-000777", index).candidate.ref, index.products[12].ref);
    assert.equal(searchProducts("SKU-ABC-42", index).candidate.ref, index.products[12].ref);
});

test("близкие позиции возвращают ambiguous, слабый запрос — not_found", () => {
    assert.equal(searchProducts("фн 15", index).decision, "ambiguous");
    assert.equal(searchProducts("совершенно неизвестный предмет", index).decision, "not_found");
});

test("синхронизация запрашивает только безопасные поля и GET-страницы", async () => {
    const calls = [];
    const client = { get: async (entity, config) => {
        calls.push({ entity, config });
        return { data: { value: [] } };
    } };
    assert.deepEqual(await fetchProductCatalog(client), []);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].entity, "Catalog_Номенклатура");
    assert.equal(calls[0].config.params.$select, PRODUCT_FIELDS.join(","));
    assert.equal(calls[0].config.params.$filter, "DeletionMark eq false and IsFolder eq false");
});

test("явный запрос компонента ставит запчасть выше ККТ", () => {
    const result=searchProducts("термопринтер для атол 30ф",index);
    assert.doesNotMatch(result.candidates[0].name,/^ККТ/u);
    assert.ok(result.candidates.findIndex(x=>/Термопечатающий механизм/u.test(x.name)) < result.candidates.findIndex(x=>/^ККТ/u.test(x.name)));
});
