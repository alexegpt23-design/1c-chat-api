const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
    LEGAL_FORM_OOO, LEGAL_FORM_IP, normalizeCounterparty,
} = require("../counterparty-search-normalizer");
const {
    COUNTERPARTY_FIELDS, buildCounterpartyDocument, fetchCounterparties,
    scoreCounterparty, searchCounterparties, verifyCounterparty,
} = require("../counterparty-search-service");

const ref = digit => `00000000-0000-0000-0000-${String(digit).padStart(12, "0")}`;
function company(id, name, fullName = name, inn = "", code = "") {
    return buildCounterpartyDocument({
        Ref_Key: ref(id), DataVersion: "v1", Description: name,
        НаименованиеПолное: fullName, ИНН: inn, Code: code,
    });
}
const trading = company(1, "ТОРГОВЫЕ РЕШЕНИЯ ООО",
    'Общество с ограниченной ответственностью "Торговые решения"', "7701234567", "000001");
const soloviev = company(2, "ИП Соловьев",
    "Индивидуальный предприниматель Соловьёв Иван Иванович", "770123456789", "000002");

for (const query of [
    'ООО "Торговые решения"',
    "Торговые решения ООО",
    "Торговые ООО решения",
    "общество с ограниченной ответственностью Торговые решения",
]) {
    test("ООО position/form: " + query, () => {
        const normalized = normalizeCounterparty(query);
        assert.equal(normalized.legalForm, LEGAL_FORM_OOO);
        assert.equal([...normalized.tokens].sort().join(" "), "решения торговые");
        assert.equal(searchCounterparties(query, [trading]).candidate.ref, trading.ref);
    });
}

for (const query of [
    "ИП Соловьев",
    "Соловьев ИП",
    "Соловьев ИП услуги",
    "Индивидуальный предприниматель Соловьёв",
]) {
    test("ИП position/form: " + query, () => {
        assert.equal(normalizeCounterparty(query).legalForm, LEGAL_FORM_IP);
        assert.equal(searchCounterparties(query, [soloviev]).candidates[0].ref, soloviev.ref);
    });
}

test("склонения названия компании совпадают морфологически", () => {
    for (const query of ["торговым решениям", "торговых решений"]) {
        const scored = scoreCounterparty(query, trading);
        assert.equal(scored.morphologyScore, 200);
        assert.equal(searchCounterparties(query, [trading]).candidate.ref, trading.ref);
    }
});

test("склонения фамилии ИП и ё/е совпадают", () => {
    for (const query of ["соловьева", "соловьеву", "СОЛОВЬЁВ"]) {
        const scored = scoreCounterparty(query, soloviev);
        assert.ok(scored.morphologyScore >= 100);
        assert.equal(searchCounterparties(query, [soloviev]).candidate.ref, soloviev.ref);
    }
});

test("кавычки, дефисы, точки, регистр и порядок слов нормализуются", () => {
    const a = normalizeCounterparty('о.О.О. — «ТоРгОвЫе-РеШеНиЯ»');
    assert.deepEqual(a.morphologyTokens, ["торгов", "решен"]);
    const result = searchCounterparties("решения торговые ооо", [trading]);
    assert.equal(result.candidate.ref, trading.ref);
});

test("явный legal form conflict исключает кандидата", () => {
    const wrong = scoreCounterparty("ИП Торговые решения", trading);
    assert.equal(wrong.legalConflict, true);
    assert.ok(wrong.finalScore < 0);
    assert.equal(searchCounterparties("ИП Торговые решения", [trading]).decision, "not_found");
});

test("без legal form похожие компании остаются ambiguous", () => {
    const second = company(3, "Торговые решения ИП");
    const result = searchCounterparties("торговые решения", [trading, second]);
    assert.equal(result.decision, "ambiguous");
    assert.equal(result.candidate, null);
});

test("точный ИНН имеет абсолютный приоритет", () => {
    const other = company(3, "Похожее название ООО", "", "1234567890");
    const result = searchCounterparties("7701234567", [other, trading]);
    assert.equal(result.decision, "selected");
    assert.equal(result.candidate.ref, trading.ref);
    assert.ok(result.candidate.reasons.includes("exact-inn"));
});

test("точный Code поддерживается", () => {
    const result = searchCounterparties("000002", [trading, soloviev]);
    assert.equal(result.candidate.ref, soloviev.ref);
});

test("GET sync использует только нужные поля и фильтры", async () => {
    const calls = [];
    const client = { get: async (entity, config) => {
        calls.push({ entity, config });
        return { data: { value: [] } };
    } };
    assert.deepEqual(await fetchCounterparties(client), []);
    assert.equal(calls[0].entity, "Catalog_Контрагенты");
    assert.equal(calls[0].config.params.$select, COUNTERPARTY_FIELDS.join(","));
    assert.equal(calls[0].config.params.$filter, "DeletionMark eq false and IsFolder eq false");
});

test("финальный контрагент повторно читается из 1С по Ref_Key", async () => {
    const calls = [];
    const catalog = { resolve: async (...args) => { calls.push(args); return { Ref_Key: trading.ref }; } };
    await verifyCounterparty(trading.ref, catalog);
    assert.deepEqual(calls, [["client", trading.ref]]);
});


test("точное морфологическое совпадение с большим отрывом выбирается", () => {
    const noise = company(4, "Деловые решения ООО");
    const result = searchCounterparties("торговым решениям", [trading, noise]);
    assert.equal(result.decision, "selected");
    assert.equal(result.candidate.ref, trading.ref);
});
