const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
process.env.ONEC_URL = "http://onec.invalid/odata/standard.odata/";
process.env.ONEC_USER = "test-user";
process.env.ONEC_PASSWORD = "test-password";
process.env.API_KEY = "pdf-test-api-key";
process.env.PUBLIC_BASE_URL = "https://api.example.test";
const { oneC, redact } = require("../onec-client");
const app = require("../server");
const { renderInvoice, pdfUrl } = require("../invoice-pdf-service");
const { validPdfAccess, signPdfUrl } = require("../pdf-access");
const ref = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
let server, baseURL, calls, posted = true, incomplete = false, missing = false;
before(async () => {
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseURL = `http://127.0.0.1:${server.address().port}`;
    oneC.defaults.adapter = async config => {
        calls.push(config);
        let data;
        if (config.url.startsWith("Document_") && missing) throw { config, response: { status: 404, data: {} } };
        if (config.url.startsWith("Document_")) data = { Ref_Key: ref(1), Number: "ИНФ-000057", Date: "2026-09-12T12:00:00", Posted: posted,
            Организация_Key: ref(2), Контрагент_Key: ref(3), ДоговорКонтрагента_Key: ref(4), ВалютаДокумента_Key: ref(5),
            СуммаВключаетНДС: true, СуммаДокумента: 12200,
            Товары: [{ Содержание: "Фискальный накопитель на 15 месяцев", Количество: 1, Цена: incomplete ? null : 12200, СтавкаНДС: "НДС22", СуммаНДС: 2200, Сумма: 12200 }] };
        else if (config.url.startsWith("Catalog_Организации")) data = { Ref_Key: ref(2), Description: "ООО ПОСТАВЩИК", ИНН: "1234567890" };
        else if (config.url.startsWith("Catalog_Контрагенты")) data = { Ref_Key: ref(3), Description: "ООО ГИПЕР" };
        else if (config.url.startsWith("Catalog_Договоры")) data = { Ref_Key: ref(4), Description: "Основной договор" };
        else if (config.url.startsWith("Catalog_Валюты")) data = { Ref_Key: ref(5), Description: "руб." };
        else throw new Error("Unexpected request " + config.url);
        return { data, status: 200, statusText: "OK", headers: {}, config };
    };
});
after(() => new Promise(resolve => server.close(resolve)));

async function pdfText(buffer) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, isEvalSupported: false });
    const pdf = await loading.promise;
    try {
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) pages.push((await (await pdf.getPage(n)).getTextContent()).items.map(item => item.str).join(" "));
        return { pages, text: pages.join(" ").replace(/\s+/g, " ") };
    } finally { await loading.destroy(); }
}

test("все маршруты требуют API-ключ до обращения в 1С, включая JSON, PDF и неизвестные пути", async () => {
    calls = [];
    for (const [method, path] of [["GET", "/ping"], ["GET", "/openapi.json"], ["GET", `/invoice/${ref(1)}/pdf`], ["POST", "/invoice-confirm"], ["POST", "/create-invoice"], ["POST", "/invoice-preview-text"], ["GET", "/unknown"]]) {
        for (const key of [undefined, "wrong"]) {
            const response = await fetch(baseURL + path, { method, headers: key ? { "X-API-Key": key } : {} });
            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { error: "Unauthorized" });
        }
    }
    assert.equal(calls.length, 0);
    assert.equal(redact(process.env.API_KEY), "[скрыто]");
});

test("PDF по подписанной ссылке читается на телефоне и содержит все реквизиты и кириллицу", async () => {
    calls = []; posted = true;
    const url = new URL(pdfUrl(ref(1)));
    const response = await fetch(baseURL + url.pathname + url.search);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /application\/pdf/);
    assert.match(decodeURIComponent(response.headers.get("content-disposition")), /Счет_ИНФ-000057.pdf/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const buffer = Buffer.from(await response.arrayBuffer());
    assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
    const { text } = await pdfText(buffer);
    for (const expected of ["ИНФ-000057", "12.09.2026", "ООО ПОСТАВЩИК", "ООО ГИПЕР", "Основной договор", "Фискальный накопитель на 15 месяцев", "Количество: 1", "12 200,00", "22%", "2 200,00", "Всего к оплате"]) assert.ok(text.includes(expected), expected + ": " + text);
    assert.ok(calls.every(call => call.method === "get"));
});

test("PDF также доступен по API-ключу; некорректный ID и непроведённый счёт отклоняются", async () => {
    calls = []; posted = true;
    const headers = { "X-API-Key": process.env.API_KEY };
    assert.equal((await fetch(baseURL + `/invoice/${ref(1)}/pdf`, { headers })).status, 200);
    calls = [];
    assert.equal((await fetch(baseURL + "/invoice/bad/pdf", { headers })).status, 400);
    assert.equal(calls.length, 0);
    posted = false;
    assert.equal((await fetch(baseURL + `/invoice/${ref(1)}/pdf`, { headers })).status, 409);
    posted = true;
});

test("подпись привязана к счёту, сроку, методу и маршруту; API-ключ не попадает в URL", async () => {
    const now = Date.now();
    const url = new URL(signPdfUrl(`https://api.example.test/invoice/${ref(1)}/pdf`, ref(1), now));
    const req = { method: "GET", path: url.pathname, query: Object.fromEntries(url.searchParams) };
    assert.equal(validPdfAccess(req, now), true);
    assert.equal(validPdfAccess(req, now + 900000), false);
    assert.equal(validPdfAccess({ ...req, method: "POST" }, now), false);
    assert.equal(validPdfAccess({ ...req, path: `/invoice/${ref(2)}/pdf` }, now), false);
    assert.equal(validPdfAccess({ ...req, path: "/ping" }, now), false);
    assert.equal(validPdfAccess({ ...req, query: { ...req.query, expires: String(Number(req.query.expires) + 1) } }, now), false);
    assert.equal(validPdfAccess({ ...req, query: { ...req.query, token: "0".repeat(64) } }, now), false);
    assert.equal(url.href.includes(process.env.API_KEY), false);
    calls = [];
    assert.equal((await fetch(baseURL + `/invoice/${ref(2)}/pdf` + url.search)).status, 401);
    assert.equal(calls.length, 0);
});

test("PDF отсутствующего документа и неполные суммы не выдаются за корректный счёт", async () => {
    calls = [];
    const headers = { "X-API-Key": process.env.API_KEY };
    try {
        missing = true;
        assert.equal((await fetch(baseURL + `/invoice/${ref(1)}/pdf`, { headers })).status, 404);
        missing = false; incomplete = true;
        assert.equal((await fetch(baseURL + `/invoice/${ref(1)}/pdf`, { headers })).status, 502);
        assert.ok(calls.every(call => call.method === "get"));
    } finally { missing = false; incomplete = false; }
});

test("ChatGPT получает защищённую схему с обязательным подтверждением создания", async () => {
    const response = await fetch(baseURL + "/openapi.json", { headers: { "X-API-Key": process.env.API_KEY } });
    assert.equal(response.status, 200);
    const schema = await response.json();
    assert.equal(schema.components.securitySchemes.ApiKey.name, "X-API-Key");
    assert.deepEqual(schema.security, [{ ApiKey: [] }]);
    assert.equal(schema.paths["/invoice-confirm"].post["x-openai-isConsequential"], true);
    assert.equal(schema.paths["/invoice-preview-text"].post["x-openai-isConsequential"], false);
    assert.equal(schema.paths["/create-invoice"], undefined);
    assert.equal(schema.paths["/invoice-create-from-text"], undefined);
});

test("многостраничный PDF не теряет длинные наименования, латиницу и итог", async () => {
    const item = { name: "ФН-1.2 USB " + "длинное наименование ".repeat(10), quantity: 2, price: 100, vat: "БезНДС", vatAmount: 0, total: 200 };
    const buffer = await renderInvoice({ number: "ТЕСТ-42", date: "2026-09-12", organization: { Description: "Поставщик" }, client: { Description: "Клиент" }, contract: { Description: "Договор" }, currency: { Description: "руб." }, items: Array.from({ length: 35 }, (_, i) => ({ ...item, name: `${item.name} конец${i}` })), total: 7000, priceIncludesVat: true });
    const { text, pages } = await pdfText(buffer);
    assert.ok(pages.length > 1);
    assert.ok(text.includes("USB"));
    assert.ok(text.includes("конец34"));
    assert.ok(text.includes("7 000,00"));
});
