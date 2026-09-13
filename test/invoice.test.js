const { test, beforeEach, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
process.env.ONEC_TEST_STATE_FILE = path.join(require("node:os").tmpdir(), `onec-invoice-test-${process.pid}.json`);
// Тесты никогда не используют реквизиты или сеть рабочей базы.
process.env.ONEC_URL = "http://onec.invalid/odata/standard.odata/";
process.env.ONEC_USER = "test-user";
process.env.ONEC_PASSWORD = "test-password";
process.env.API_KEY = "test-api-key";
process.env.PUBLIC_BASE_URL = "https://api.example.test";
process.env.PRODUCT_SEARCH_MODE = "odata";
process.env.COUNTERPARTY_SEARCH_MODE = "odata";
delete process.env.ONEC_VAT_RATE;
const { oneC } = require("../onec-client");
const app = require("../server");
const { calculate } = require("../invoice-service");
const { parseInvoiceText } = require("../invoice-text-service");
const invoiceText = "Выставь счёт ООО Торговые решения. Фискальный накопитель на 15 месяцев. Цена 12200. НДС 22";
const ref = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const client = { Ref_Key: ref(1), Description: "Клиент", ИНН: "1234567890" };
const contract = { Ref_Key: ref(2), Description: "Договор", Owner_Key: ref(1), ВидДоговора: "СПокупателем", Организация_Key: ref(4), ВалютаВзаиморасчетов_Key: ref(5) };
const product = { Ref_Key: ref(3), Description: "Товар" };
const input = { clientName: "Клиент", productName: "Товар", contractRef: ref(2), quantity: 1, price: 12200, vatRate: 22 };
let calls, mode, server, baseURL;
before(async () => {
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
    fs.rmSync(process.env.ONEC_TEST_STATE_FILE, { force: true });
    return new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
    fs.rmSync(process.env.ONEC_TEST_STATE_FILE, { force: true });
    calls = []; mode = "ok";
    oneC.defaults.adapter = async config => {
        calls.push(config);
        let data;
        if (config.url === "/") data = {};
        else if (config.url === "Catalog_Контрагенты") data = { value: mode === "ambiguous" ? [client, { ...client, Ref_Key: ref(9) }] : mode === "missing" ? [] : [client] };
        else if (config.url === "Catalog_ДоговорыКонтрагентов") data = { value: mode === "contractMissing" ? [] : mode === "contractAmbiguous" && !config.params.$filter.includes("and Ref_Key eq") ? [contract, { ...contract, Ref_Key: ref(8) }] : [{ ...contract, Owner_Key: mode === "wrongOwner" ? ref(9) : ref(1), ДоговорЗакрыт: mode === "closedContract" }] };
        else if (config.url === "Catalog_Номенклатура") data = { value: mode === "productMissing" || (mode === "productAlias" && config.params.$filter.includes("substringof('ФН 15 месяцев'")) ? [] : mode === "productAmbiguous" && !config.params.$filter.includes("and Ref_Key eq") ? [product, { ...product, Ref_Key: ref(7) }] : [product] };
        else if (config.url.endsWith("/Post()")) {
            if (mode === "postError") throw { config, response: { status: 500, data: { "odata.error": { code: "-1", message: { value: "Не заполнен склад" } } } } };
            data = {};
        } else if (config.url.startsWith("Document_")) {
            if (mode === "timeout" && config.method === "post") throw { config, code: "ECONNABORTED" };
            data = { Ref_Key: ref(6), Number: "AUTO-000001", Date: "2026-09-12T15:00:00", СуммаДокумента: 12200, Posted: config.method === "get" && mode !== "unposted" };
        } else throw new Error("Unexpected request " + config.url);
        return { data, status: 200, statusText: "OK", headers: {}, config };
    };
});
async function post(path, data) {
    const response = await fetch(baseURL + path, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
}
test("/ping сохраняет успешный формат ответа", async () => {
    assert.deepEqual(await (await fetch(baseURL + "/ping", { headers: { "X-API-Key": process.env.API_KEY } })).json(), { ok: true, message: "1С доступна" });
});
test("поиск экранирует апострофы и кодирует пробелы как %20", async () => {
    const result = await post("/find-client", { name: "O'Брайен & Ко" });
    assert.equal(result.status, 200);
    assert.equal(result.data[0].inn, client.ИНН);
    const uri = oneC.getUri(calls[0]);
    assert.match(uri, /%20/); assert.ok(!uri.includes("+"));
    assert.match(calls[0].params.$filter, /O''Брайен & Ко/);
});
test("предпросмотр не выполняет запись и рассчитывает НДС", async () => {
    const result = await post("/preview-invoice", input);
    assert.equal(result.status, 200);
    assert.equal(result.data.created, false);
    assert.equal(result.data.vatAmount, 2200);
    assert.equal(result.data.total, 12200);
    assert.ok(calls.every(call => call.method === "get"));
});
test("создание без Number, затем Post и чтение действительного результата", async () => {
    const result = await post("/create-invoice", input);
    assert.equal(result.status, 201); assert.equal(result.data.posted, true);
    assert.equal(result.data.number, "AUTO-000001");
    const writes = calls.filter(call => call.method === "post");
    assert.equal(writes.length, 2);
    const payload = JSON.parse(writes[0].data);
    assert.equal(Object.hasOwn(payload, "Number"), false);
    assert.equal(payload.Posted, false);
    assert.equal(payload.Товары[0].Номенклатура, product.Ref_Key);
    assert.equal(payload.Товары[0].Номенклатура_Type, "StandardODATA.Catalog_Номенклатура");
    assert.equal(payload.Товары[0].СуммаНДС, 2200);
    assert.ok(writes[1].url.endsWith("/Post()"));
    assert.equal(calls.at(-1).method, "get");
});
test("неоднозначный поиск и чужой договор не создают документ", async () => {
    mode = "ambiguous";
    assert.equal((await post("/create-invoice", input)).status, 409);
    mode = "wrongOwner";
    assert.equal((await post("/create-invoice", input)).status, 422);
    mode = "missing";
    assert.equal((await post("/create-invoice", input)).status, 404);
    assert.ok(calls.every(call => call.method === "get"));
});
test("ошибка проведения возвращает Ref_Key созданного документа без повторной записи", async () => {
    mode = "postError";
    const result = await post("/create-invoice", input);
    assert.equal(result.status, 502);
    assert.equal(result.data.details.Ref_Key, ref(6));
    assert.equal(result.data.details.created, true);
    assert.equal(result.data.details.posted, null);
    assert.equal(result.data.details.retrySafe, false);
    assert.match(result.data.error, /Не заполнен склад/);
    assert.equal(calls.filter(call => call.method === "post").length, 2);
});
test("Posted=false после Post не выдаётся за успех", async () => {
    mode = "unposted";
    assert.equal((await post("/create-invoice", input)).status, 502);
});
test("тайм-аут создания не вызывает повторный POST", async () => {
    mode = "timeout";
    const result = await post("/create-invoice", input);
    assert.equal(result.status, 504);
    assert.equal(result.data.details.created, "unknown");
    assert.equal(calls.filter(call => call.method === "post").length, 1);
});
test("валидация отклоняет ошибочный JSON, отрицательные значения и ручной Number", async () => {
    for (const change of [{ quantity: -1 }, { price: "" }, { Number: "123" }, { priceIncludesVat: "false" }, { date: "2026-02-30T00:00:00" }]) {
        assert.equal((await post("/create-invoice", { ...input, ...change })).status, 400);
    }
    const response = await fetch(baseURL + "/find-client", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY }, body: "{" });
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
});
test("денежное округление, НДС сверху, нулевая ставка и БезНДС", () => {
    assert.equal(calculate({ quantity: 3, price: 0.1, vatRate: "БезНДС" }).total, 0.3);
    assert.equal(calculate({ quantity: 0.5, price: 0.01, vatRate: 0 }).total, 0.01);
    assert.equal(calculate({ quantity: 1, price: 10000, vatRate: 22, priceIncludesVat: false }).total, 12200);
    assert.equal(calculate({ quantity: 1, price: 100, vatRate: 0 }).vatCode, "НДС0");
    assert.equal(calculate({ quantity: 1, price: 100, vatRate: "БезНДС" }).vatCode, "БезНДС");
});
test("dryRun=true на обоих маршрутах создания выполняет только чтение", async () => {
    for (const [url, body] of [["/create-invoice", { ...input, dryRun: true }], ["/test-create-invoice", { dryRun: true }]]) {
        const result = await post(url, body);
        assert.equal(result.status, 200);
        assert.equal(result.data.dryRun, true);
        assert.equal(result.data.created, false);
        assert.equal(result.data.total, 12200);
    }
    assert.ok(calls.every(call => call.method === "get"));
    assert.equal(fs.existsSync(process.env.ONEC_TEST_STATE_FILE), false);
});
test("боевой тест по умолчанию создаёт один документ и повторно читает его", async () => {
    const first = await post("/test-create-invoice", {});
    assert.equal(first.status, 201);
    assert.deepEqual(first.data, { Number: "AUTO-000001", Date: "2026-09-12T15:00:00", Сумма: 12200, Posted: true, Ref_Key: ref(6) });
    const payload = JSON.parse(calls.find(call => call.method === "post").data);
    assert.equal(Object.hasOwn(payload, "Number"), false);
    assert.equal(payload.Posted, false);
    assert.equal(payload.Товары[0].Количество, 1);
    assert.equal(payload.Товары[0].Цена, 12200);
    assert.equal(payload.Товары[0].СтавкаНДС, "НДС22");
    assert.match(payload.Комментарий, /Боевой тест API/);
    const second = await post("/test-create-invoice", {});
    assert.deepEqual(second.data, first.data);
    assert.equal(calls.filter(call => call.method === "post").length, 2);
    assert.equal(JSON.parse(fs.readFileSync(process.env.ONEC_TEST_STATE_FILE)).status, "completed");
});
test("после ошибки проведения боевой тест сохраняет Ref_Key и блокирует новый документ", async () => {
    mode = "postError";
    assert.equal((await post("/test-create-invoice", {})).status, 502);
    const state = JSON.parse(fs.readFileSync(process.env.ONEC_TEST_STATE_FILE));
    assert.equal(state.details.Ref_Key, ref(6));
    mode = "ok";
    assert.equal((await post("/test-create-invoice", {})).status, 409);
    assert.equal(calls.filter(call => call.method === "post").length, 2);
});
test("боевой тест отклоняет подмену реквизитов и нечисловой dryRun", async () => {
    for (const body of [{ price: 1 }, { Number: "1" }, { dryRun: "false" }]) {
        assert.equal((await post("/test-create-invoice", body)).status, 400);
    }
    assert.equal(calls.length, 0);
});
test("разбор обычного текста: порядок ООО, количество по умолчанию, цена и НДС", () => {
    assert.deepEqual(parseInvoiceText(invoiceText), { clientName: "Торговые решения", productName: "Фискальный накопитель на 15 месяцев", quantity: 1, price: 12200, vatRate: 22, priceIncludesVat: true });
    const parsed = parseInvoiceText('Создай счет для «Торговые решения» ООО; Товар: ФН-1.2; Количество 2,5; Цена 12 200,50 руб; НДС 22% сверху; Договор: Основной');
    assert.equal(parsed.clientName, "Торговые решения");
    assert.equal(parsed.productName, "ФН-1.2");
    assert.equal(parsed.quantity, 2.5);
    assert.equal(parsed.price, 12200.5);
    assert.equal(parsed.priceIncludesVat, false);
    assert.equal(parsed.contractName, "Основной");
    assert.equal(parseInvoiceText(invoiceText.replace("НДС 22", "Без НДС")).vatRate, "БезНДС");
});
test("предпросмотр из текста показывает реквизиты и не записывает документ", async () => {
    const result = await post("/invoice-preview-from-text", { text: invoiceText });
    assert.equal(result.status, 200);
    assert.equal(result.data.created, false);
    assert.equal(result.data.client.ref, client.Ref_Key);
    assert.equal(result.data.product.ref, product.Ref_Key);
    assert.equal(result.data.contract.ref, contract.Ref_Key);
    assert.equal(result.data.vatAmount, 2200);
    assert.equal(result.data.total, 12200);
    assert.match(calls[0].params.$filter, /substringof\('Торговые решения'/);
    assert.ok(calls.every(call => call.method === "get"));
});
test("создание из текста использует общий сервис без Number, Post и контрольное чтение", async () => {
    const result = await post("/invoice-create-from-text", { text: invoiceText });
    assert.equal(result.status, 201);
    assert.deepEqual(result.data, { Number: "AUTO-000001", Date: "2026-09-12T15:00:00", Сумма: 12200, Posted: true, Ref_Key: ref(6) });
    const writes = calls.filter(call => call.method === "post");
    assert.equal(writes.length, 2);
    const payload = JSON.parse(writes[0].data);
    assert.equal(Object.hasOwn(payload, "Number"), false);
    assert.equal(payload.Posted, false);
    assert.equal(payload.Товары[0].Количество, 1);
    assert.equal(payload.Товары[0].Цена, 12200);
    assert.equal(payload.Товары[0].СуммаНДС, 2200);
    assert.ok(writes[1].url.endsWith("/Post()"));
    assert.equal(calls.at(-1).method, "get");
});
test("отсутствующие клиент, товар и договор блокируют создание из текста", async () => {
    for (const missing of ["missing", "productMissing", "contractMissing", "closedContract"]) {
        mode = missing;
        const result = await post("/invoice-create-from-text", { text: invoiceText });
        assert.equal(result.status, 404, missing);
        assert.deepEqual(result.data.details.candidates, []);
    }
    assert.ok(calls.every(call => call.method === "get"));
});
test("неоднозначный поиск из текста возвращает варианты для каждого справочника", async () => {
    for (const [value, field] of [["ambiguous", "clientRef"], ["productAmbiguous", "productRef"], ["contractAmbiguous", "contractRef"]]) {
        mode = value;
        const result = await post("/invoice-create-from-text", { text: invoiceText });
        assert.equal(result.status, 409);
        assert.equal(result.data.details.field, field);
        assert.equal(result.data.details.candidates.length, 2);
    }
    assert.ok(calls.every(call => call.method === "get"));
});
test("выбор из вариантов договора повторяет preview, чужая ссылка отклоняется", async () => {
    mode = "contractAmbiguous";
    assert.equal((await post("/invoice-preview-from-text", { text: invoiceText, contractRef: contract.Ref_Key })).status, 200);
    const rejected = await post("/invoice-create-from-text", { text: invoiceText, contractRef: ref(99) });
    assert.equal(rejected.status, 422);
    assert.ok(calls.every(call => call.method === "get"));
});
test("неполный текст, повторная цена, неизвестные условия и отрицательные суммы отклоняются до поиска", async () => {
    for (const text of ["", invoiceText.replace(". Цена 12200", ""), invoiceText.replace(". НДС 22", ""), invoiceText + ". Цена 1", invoiceText + ". Скидка 10%", invoiceText.replace("Цена 12200", "Цена -1"), invoiceText.replace("НДС 22", "НДС 99")]) {
        assert.equal((await post("/invoice-create-from-text", { text })).status, 400, text);
    }
    assert.equal((await post("/invoice-create-from-text", { text: invoiceText, Number: "123" })).status, 400);
    assert.equal(calls.length, 0);
});
test("dryRun для текста не создаёт счёт, ошибка проведения сохраняет Ref_Key", async () => {
    assert.equal((await post("/invoice-create-from-text", { text: invoiceText, dryRun: true })).status, 200);
    assert.ok(calls.every(call => call.method === "get"));
    mode = "postError";
    const result = await post("/invoice-create-from-text", { text: invoiceText });
    assert.equal(result.status, 502);
    assert.equal(result.data.details.Ref_Key, ref(6));
    assert.equal(result.data.details.retrySafe, false);
});
test("HTTP подтверждение: preview только читает, confirm создаёт и проводит ровно один раз", async () => {
    const preview = await post("/invoice-confirmation-preview", { text: invoiceText });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.created, false);
    assert.equal(preview.data.total, 12200);
    assert.equal(preview.data.vatAmount, 2200);
    assert.ok(preview.data.confirmationId);
    assert.ok(calls.every(call => call.method === "get"));
    const body = { confirmationId: preview.data.confirmationId };
    const first = await post("/invoice-confirm", body);
    assert.equal(first.status, 201);
    assert.equal(first.data.Number, "AUTO-000001");
    assert.equal(first.data.Posted, true);
    const writes = calls.filter(call => call.method === "post");
    assert.equal(writes.length, 2);
    const payload = JSON.parse(writes[0].data);
    assert.equal(Object.hasOwn(payload, "Number"), false);
    assert.equal(payload.Posted, false);
    assert.equal(payload.Date, preview.data.date);
    assert.equal(payload.СуммаДокумента, preview.data.total);
    assert.ok(writes[1].url.endsWith("/Post()"));
    const callCount = calls.length;
    const repeat = await post("/invoice-confirm", body);
    assert.equal(repeat.status, 200);
    assert.deepEqual(repeat.data, first.data);
    assert.equal(calls.length, callCount);
});
test("HTTP confirmation preview не выдаёт ID при неоднозначном поиске", async () => {
    mode = "contractAmbiguous";
    const result = await post("/invoice-confirmation-preview", { text: invoiceText });
    assert.equal(result.status, 409);
    assert.equal(result.data.confirmationId, undefined);
    assert.equal(result.data.details.field, "contractRef");
    assert.equal(result.data.details.candidates.length, 2);
    assert.ok(calls.every(call => call.method === "get"));
});
test("гибкий текст ищет ГИПЕР в каталоге и раскрывает ФН через поиск товара", async () => {
    mode = "productAlias";
    const result = await post("/invoice-preview-from-text", { text: "ООО ГИПЕР, ФН 15 месяцев, 12200, НДС 22" });
    assert.equal(result.status, 200);
    assert.equal(result.data.total, 12200);
    assert.equal(calls[0].url, "Catalog_Контрагенты");
    assert.match(calls[0].params.$filter, /substringof\('ГИПЕР'/);
    const productQueries = calls.filter(call => call.url === "Catalog_Номенклатура");
    assert.match(productQueries[0].params.$filter, /ФН 15 месяцев/);
    assert.match(productQueries[1].params.$filter, /Фискальный накопитель на 15 месяцев/);
    assert.ok(calls.every(call => call.method === "get"));
});
test("гибкий текст возвращает HTTP 400 с указанием недостающей цены", async () => {
    const result = await post("/invoice-confirmation-preview", { text: "ООО ГИПЕР, ФН 15 месяцев, НДС 22" });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /цена/);
    assert.deepEqual(result.data.details.missing, ["price"]);
    assert.equal(calls.length, 0);
});

test("новый сценарий из текста: компактный preview, подтверждение и ссылка на PDF", async () => {
    const preview = await post("/invoice-preview-text", { text: "Выставь счёт ООО ГИПЕР. Фискальный накопитель на 15 месяцев. 12.200 руб. с НДС 22" });
    assert.equal(preview.status, 200);
    assert.equal(preview.data.status, "preview");
    assert.equal(preview.data.client, client.Description);
    assert.equal(preview.data.product, product.Description);
    assert.equal(preview.data.price, 12200);
    assert.equal(preview.data.quantity, 1);
    assert.equal(preview.data.vat, 22);
    assert.equal(preview.data.total, 12200);
    assert.ok(calls.every(call => call.method === "get"));
    const result = await post("/invoice-confirm", { confirmationId: preview.data.confirmationId });
    assert.equal(result.status, 201);
    assert.equal(result.data.number, "AUTO-000001");
    assert.equal(result.data.posted, true);
    assert.equal(result.data.ref, ref(6));
    const url = new URL(result.data.pdfUrl);
    assert.equal(url.origin, "https://api.example.test");
    assert.equal(url.pathname, `/invoice/${ref(6)}/pdf`);
    assert.ok(url.searchParams.get("token"));
    assert.equal(calls.filter(call => call.method === "post").length, 2);
});

test("новый preview не выдаёт подтверждение при нехватке цены и неоднозначном поиске", async () => {
    const missing = await post("/invoice-preview-text", { text: "ООО ГИПЕР. ФН 15 месяцев. НДС 22" });
    assert.equal(missing.status, 400);
    assert.equal(missing.data.error, "Не указана цена");
    assert.equal(calls.length, 0);
    for (const value of ["ambiguous", "productAmbiguous", "contractAmbiguous"]) {
        mode = value;
        const result = await post("/invoice-preview-text", { text: invoiceText });
        assert.equal(result.status, 409);
        assert.equal(result.data.confirmationId, undefined);
        assert.equal(result.data.details.candidates.length, 2);
    }
    assert.ok(calls.every(call => call.method === "get"));
});
