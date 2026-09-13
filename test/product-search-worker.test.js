const { test } = require("node:test");
const assert = require("node:assert/strict");
const { startProductSearchWorker, MAX_QUERY_LENGTH } = require("../product-search-worker");
const { createProductSearchClient, ProductSearchWorkerError } = require("../product-search-client");
const { buildSearchDocument } = require("../product-catalog-sync");
const { scoreProduct } = require("../product-search-service");

function document(name, service) {
    return buildSearchDocument({
        Ref_Key: name, DataVersion: "v1", Code: "", Description: name,
        НаименованиеПолное: name, Артикул: "", ВидНоменклатуры_Key: "type",
        НоменклатурнаяГруппа_Key: "group", Parent_Key: "parent", Услуга: service,
    });
}
function fixture() {
    return {
        bundle: {
            index: { products: [document("ККТ АТОЛ 27Ф без ФН", false)] },
            metadata: { dimension: 384 },
        },
        embeddingService: { isLoaded: false },
        search: async query => ({
            decision: "ambiguous", candidate: null,
            candidates: [{ name: query, score: 100 }],
        }),
        host: "127.0.0.1",
        port: 0,
    };
}

test("hardware query существенно штрафует услугу", () => {
    const hardware = document("ККТ АТОЛ 27Ф без ФН", false);
    const service = document("Работа специалиста для ККТ АТОЛ 27Ф", true);
    const query = "касса атол двадцать семь без накопителя";
    const hardwareScore = scoreProduct(query, hardware);
    const serviceScore = scoreProduct(query, service);
    assert.ok(hardwareScore.score - serviceScore.score >= 100);
    assert.ok(serviceScore.reasons.includes("service-for-hardware-penalty"));
});

test("явный service intent не штрафует услугу", () => {
    const service = document("Работа специалиста для ККТ АТОЛ 27Ф", true);
    const result = scoreProduct("работа специалиста атол 27ф", service);
    assert.ok(result.reasons.includes("requested-service"));
    assert.ok(!result.reasons.includes("service-for-hardware-penalty"));
});

test("worker /health и /search доступны только на заданном localhost", async t => {
    const worker = await startProductSearchWorker(fixture());
    t.after(() => worker.close());
    assert.equal(worker.host, "127.0.0.1");
    const health = await fetch(`http://127.0.0.1:${worker.port}/health`).then(r => r.json());
    assert.deepEqual(health, { ok: true, modelLoaded: false, indexItems: 1, embeddingDimension: 384 });
    const response = await fetch(`http://127.0.0.1:${worker.port}/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "атол 27ф" }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).decision, "ambiguous");
});

test("worker отклоняет пустой, длинный query и malformed JSON", async t => {
    const worker = await startProductSearchWorker(fixture());
    t.after(() => worker.close());
    const url = `http://127.0.0.1:${worker.port}/search`;
    for (const body of [
        JSON.stringify({ query: " " }),
        JSON.stringify({ query: "x".repeat(MAX_QUERY_LENGTH + 1) }),
        "{broken",
    ]) {
        const response = await fetch(url, {
            method: "POST", headers: { "content-type": "application/json" }, body,
        });
        assert.equal(response.status, 400);
    }
});

test("worker client различает timeout, unavailable и malformed response", async () => {
    const timeout = createProductSearchClient({
        fetch: async () => { throw new DOMException("timeout", "TimeoutError"); },
    });
    await assert.rejects(timeout.search("x"), error => error instanceof ProductSearchWorkerError && error.code === "TIMEOUT");
    const unavailable = createProductSearchClient({ fetch: async () => { throw new Error("ECONNREFUSED"); } });
    await assert.rejects(unavailable.search("x"), error => error.code === "UNAVAILABLE");
    const malformed = createProductSearchClient({
        fetch: async () => ({ ok: true, json: async () => ({ unknown: true }) }),
    });
    await assert.rejects(malformed.search("x"), error => error.code === "MALFORMED_RESPONSE");
});

test("worker client поддерживает lexical fallback", async () => {
    const client = createProductSearchClient({ fetch: async () => { throw new Error("offline"); } });
    const result = await client.searchWithFallback("фн 15", async () => ({
        decision: "ambiguous", candidate: null, candidates: [{ name: "ФН 15" }],
    }));
    assert.equal(result.embeddingStatus, "unavailable");
    assert.equal(result.decision, "ambiguous");
});

test("worker корректно закрывает listener", async () => {
    const worker = await startProductSearchWorker(fixture());
    assert.equal(worker.server.listening, true);
    await worker.close();
    assert.equal(worker.server.listening, false);
});

const SERVICE_CASES = [
    ["registration", "зарегистрировать кассу", "Регистрация/перерегистрация ККТ"],
    ["setup", "настроить кассу", "Настройка ККТ"],
    ["installation", "установить кассу", "Монтаж и установка ККТ"],
    ["repair", "отремонтировать кассу", "Ремонт ККТ"],
    ["maintenance", "техобслуживание кассы", "Сервисное обслуживание ККТ"],
    ["consultation", "консультация по 1с", "Консультационные услуги по 1С"],
    ["activation", "активировать фн", "Активация ФН"],
    ["replacement", "заменить батарейку", "Замена батарейки ККТ"],
    ["update", "обновить атол connect", "Обновление АТОЛ Connect"],
    ["diagnostics", "диагностировать кассу", "Диагностика ККТ"],
];

for (const [subtype, query, name] of SERVICE_CASES) {
    test(`service subtype: ${subtype}`, () => {
        const queryAnalysis = require("../product-search-normalizer").analyzeProductText(query);
        const item = document(name, true);
        const result = scoreProduct(query, item);
        assert.equal(queryAnalysis.attributes.serviceSubtype, subtype);
        assert.equal(item.attributes.serviceSubtype, subtype);
        assert.equal(result.serviceSubtypeAdjustment, 150);
        assert.ok(result.reasons.includes(`service-subtype-match:${subtype}`));
    });
}

test("registration выше replacement даже без точной модели", () => {
    const registration = document("Регистрация/перерегистрация ККТ", true);
    const replacement = document("Работа специалиста, замена батарейки АТОЛ 27Ф", true);
    const result = require("../product-search-service").searchProducts(
        "регистрация кассы атол 27ф",
        { products: [replacement, registration] },
    );
    assert.equal(result.candidates[0].name, registration.name);
    assert.equal(result.candidates[0].serviceSubtype, "registration");
    assert.equal(scoreProduct("регистрация кассы атол 27ф", replacement).serviceSubtypeAdjustment, -190);
});

test("replacement выше registration для запроса замены", () => {
    const registration = document("Регистрация/перерегистрация ККТ", true);
    const replacement = document("Работа специалиста, замена батарейки АТОЛ 27Ф", true);
    const result = require("../product-search-service").searchProducts(
        "замена батарейки атол 27",
        { products: [registration, replacement] },
    );
    assert.equal(result.candidates[0].name, replacement.name);
});

test("универсальная услуга ниже точного subtype, но не блокируется", () => {
    const exact = document("Настройка ККТ", true);
    const universal = document("Работа специалиста с ККТ", true);
    const exactScore = scoreProduct("настройка ккт", exact);
    const universalScore = scoreProduct("настройка ккт", universal);
    assert.equal(universal.attributes.serviceSubtype, "other_service");
    assert.equal(universalScore.serviceSubtypeAdjustment, -35);
    assert.ok(exactScore.score > universalScore.score);
});

test("без subtype сохраняется service scoring без subtype adjustment", () => {
    const universal = document("Работа специалиста с ККТ", true);
    const result = scoreProduct("услуга для ккт", universal);
    assert.equal(result.queryServiceSubtype, "other_service");
    assert.equal(result.serviceSubtypeAdjustment, 0);
    assert.ok(result.reasons.includes("requested-service"));
});


test("демонтаж не определяется как installation", () => {
    const item = document("Демонтаж ККТ", true);
    assert.notEqual(item.attributes.serviceSubtype, "installation");
});

test("worker подхватывает атомарно заменённый bundle без перезапуска модели", async t => {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-reload-"));
    const metadataPath = path.join(directory, "metadata.json");
    fs.writeFileSync(metadataPath, "{}");
    let currentCount = 1;
    const makeBundle = () => ({
        index: { products: Array.from({ length: currentCount }, (_, index) => ({ name: String(index) })) },
        metadata: { dimension: 384, indexVersion: String(currentCount) },
        paths: { metadataPath },
    });
    const worker = await startProductSearchWorker({
        ...fixture(),
        bundle: makeBundle(),
        reloadIndex: true,
        loadBundle: () => makeBundle(),
        search: async (_query, bundle) => ({
            decision: "ambiguous", candidate: null,
            candidates: [{ name: String(bundle.index.products.length) }],
        }),
    });
    t.after(async () => {
        if (worker.server.listening) await worker.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    currentCount = 2;
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(metadataPath, future, future);
    const result = await fetch(`http://127.0.0.1:${worker.port}/search`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "reload" }),
    }).then(response => response.json());
    assert.equal(result.candidates[0].name, "2");
    const health = await fetch(`http://127.0.0.1:${worker.port}/health`).then(response => response.json());
    assert.equal(health.indexItems, 2);
});
