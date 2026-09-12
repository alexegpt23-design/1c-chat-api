const { oneC } = require("./onec-client");
const { AppError } = require("./errors");
const catalog = require("./catalog-service");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const DOCUMENT = "Document_СчетНаОплатуПокупателю";

function scaled(value, scale, field, positive = true) {
    if (!["number", "string"].includes(typeof value) || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(String(value))) {
        throw new AppError(`${field}: нужно число с точностью до ${scale} знаков после точки`);
    }
    const [whole, fraction = ""] = String(value).split(".");
    const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
    if ((positive && result === 0n) || result > 1000000000000n) throw new AppError(`${field}: значение вне допустимого диапазона`);
    return result;
}
function rounded(numerator, denominator) { return (numerator + denominator / 2n) / denominator; }
function calculate(input) {
    const quantity = scaled(input.quantity, 3, "quantity");
    const price = scaled(input.price, 2, "price", false);
    const vatValue = input.vatRate ?? process.env.ONEC_VAT_RATE;
    const noVat = vatValue === "БезНДС";
    const rateText = String(vatValue).replace(/^НДС/, "");
    if (!noVat && !["0", "5", "7", "10", "18", "20", "22"].includes(rateText)) {
        throw new AppError("Укажите vatRate: БезНДС, 0, 5, 7, 10, 18, 20 или 22");
    }
    const includesVat = input.priceIncludesVat ?? true;
    if (typeof includesVat !== "boolean") throw new AppError("priceIncludesVat должен быть boolean");
    const rate = noVat ? 0n : BigInt(rateText);
    const line = rounded(quantity * price, 1000n);
    const vat = rounded(line * rate, includesVat ? 100n + rate : 100n);
    const total = includesVat ? line : line + vat;
    if (total > 1000000000000n) throw new AppError("Итоговая сумма слишком велика");
    return {
        quantity: Number(quantity) / 1000, price: Number(price) / 100,
        priceIncludesVat: includesVat, vatRate: noVat ? "БезНДС" : Number(rate),
        vatCode: noVat ? "БезНДС" : `НДС${rate}`, vatAmount: Number(vat) / 100,
        lineAmount: Number(line) / 100, subtotal: Number(total - vat) / 100, total: Number(total) / 100,
    };
}
function invoiceDate(value) {
    if (value === undefined) {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
            timeZone: process.env.ONEC_TIMEZONE || "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit",
            hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
        }).formatToParts(new Date()).map(part => [part.type, part.value]));
        return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    }
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + "Z")) || new Date(value + "Z").toISOString().slice(0, 19) !== value) {
        throw new AppError("date: ожидается реальная дата YYYY-MM-DDTHH:mm:ss по времени базы 1С");
    }
    return value;
}
async function prepareInvoice(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("Ожидается JSON-объект");
    if ("Number" in input || "number" in input) throw new AppError("Номер счёта назначает 1С; не передавайте Number/number");
    const amounts = calculate(input);
    const date = invoiceDate(input.date);
    if (!input.clientRef) catalog.requiredText(input.clientName, "clientName");
    if (!input.productRef) catalog.requiredText(input.productName, "productName");
    const client = await catalog.resolve("client", input.clientRef, input.clientName);
    console.log(`[Счёт] Найден клиент: ${client.Description}, Ref_Key=${client.Ref_Key}`);
    const contract = await catalog.resolve("contract", input.contractRef, input.contractName,
        `Owner_Key eq guid'${client.Ref_Key}' and ВидДоговора eq 'СПокупателем' and ДоговорЗакрыт eq false`);
    if (contract.Owner_Key?.toLowerCase() !== client.Ref_Key.toLowerCase() || contract.ВидДоговора !== "СПокупателем" || contract.ДоговорЗакрыт) {
        throw new AppError("Договор должен быть открытым договором выбранного покупателя", 422);
    }
    console.log(`[Счёт] Найден договор: ${contract.Description}, Ref_Key=${contract.Ref_Key}`);
    const product = await catalog.resolve("product", input.productRef, input.productName);
    console.log(`[Счёт] Найден товар: ${product.Description}, Ref_Key=${product.Ref_Key}`);
    const organizationRef = catalog.guid(input.organizationRef || process.env.ONEC_ORGANIZATION_REF || contract.Организация_Key, "organizationRef");
    if (contract.Организация_Key && contract.Организация_Key !== catalog.ZERO && organizationRef !== contract.Организация_Key.toLowerCase()) {
        throw new AppError("Организация не совпадает с организацией договора", 422);
    }
    const currencyRef = catalog.guid(contract.ВалютаВзаиморасчетов_Key || process.env.ONEC_CURRENCY_REF, "currencyRef договора");
    if ((contract.Валютный || contract.РасчетыВУсловныхЕдиницах) && input.exchangeRate === undefined) {
        throw new AppError("Для валютного договора укажите exchangeRate и при необходимости exchangeMultiplicity", 422);
    }
    const exchangeRate = Number(scaled(input.exchangeRate ?? 1, 6, "exchangeRate")) / 1000000;
    const exchangeMultiplicity = input.exchangeMultiplicity ?? 1;
    if (!Number.isInteger(exchangeMultiplicity) || exchangeMultiplicity < 1 || exchangeMultiplicity > 1000000) throw new AppError("exchangeMultiplicity: нужно положительное целое до 1000000");
    const payload = {
        Date: date, Posted: false,
        Организация_Key: organizationRef, ОрганизацияПолучатель_Key: organizationRef,
        Контрагент_Key: client.Ref_Key, ДоговорКонтрагента_Key: contract.Ref_Key,
        ВалютаДокумента_Key: currencyRef, КурсВзаиморасчетов: exchangeRate, КратностьВзаиморасчетов: String(exchangeMultiplicity),
        ВидОперации: "ТоварыИУслуги", СуммаВключаетНДС: amounts.priceIncludesVat,
        ДокументБезНДС: amounts.vatCode === "БезНДС", СуммаДокумента: amounts.total,
        Товары: [{
            LineNumber: "1", Номенклатура: product.Ref_Key, Номенклатура_Type: "StandardODATA.Catalog_Номенклатура",
            Содержание: product.Description, Количество: amounts.quantity, Цена: amounts.price,
            Сумма: amounts.lineAmount, СтавкаНДС: amounts.vatCode, СуммаНДС: amounts.vatAmount,
        }],
    };
    for (const [field, key, env] of [
        ["warehouseRef", "Склад_Key", "ONEC_WAREHOUSE_REF"],
        ["responsibleRef", "Ответственный_Key", "ONEC_RESPONSIBLE_REF"],
        ["bankAccountRef", "СтруктурнаяЕдиница_Key", "ONEC_BANK_ACCOUNT_REF"],
    ]) {
        if (input[field] || process.env[env]) payload[key] = catalog.guid(input[field] || process.env[env], field);
    }
    if (input.comment !== undefined) payload.Комментарий = catalog.requiredText(input.comment, "comment");
    const preview = {
        created: false, date, client: catalog.summary("client", client), contract: catalog.summary("contract", contract),
        product: catalog.summary("product", product), organizationRef, currencyRef, ...amounts,
    };
    console.log(`[Счёт] Расчёт: клиент=${client.Ref_Key}, договор=${contract.Ref_Key}, товар=${product.Ref_Key}, количество=${amounts.quantity}, цена=${amounts.price}, НДС=${amounts.vatAmount}, итог=${amounts.total}`);
    return { preview, payload };
}
async function previewInvoice(input) { return (await prepareInvoice(input)).preview; }
function documentSummary(document) {
    return { number: document.Number, date: document.Date, amount: document.СуммаДокумента, Ref_Key: document.Ref_Key, posted: document.Posted === true };
}
async function createInvoice(input) {
    const dryRun = input?.dryRun ?? false;
    if (typeof dryRun !== "boolean") throw new AppError("dryRun должен быть boolean");
    let prepared;
    try { prepared = await prepareInvoice(input); } catch (error) {
        error.details = { ...error.details, stage: "prepare" };
        throw error;
    }
    const { payload, preview } = prepared;
    if (dryRun) {
        console.log("[Счёт] dryRun=true: расчёт выполнен, документ не создаётся");
        return { ...preview, dryRun: true };
    }
    return createPreparedInvoice(payload);
}

// Используется также подтверждением: записываем ровно показанный пользователю снимок.
async function createPreparedInvoice(payload) {
    console.log("[Счёт] Создание непроведённого документа; номер назначит 1С");
    let created;
    try {
        const response = await oneC.post(DOCUMENT, payload);
        created = response.data?.d || response.data;
    } catch (error) {
        throw new AppError(error.message, error.status || 502, { ...error.details, stage: "create", created: "unknown", retrySafe: false,
            hint: "Проверьте список счетов в 1С перед повторением запроса: сервер мог сохранить документ до разрыва соединения." });
    }
    if (!created?.Ref_Key) throw new AppError("Ответ создания не содержит Ref_Key; проверьте список счетов в 1С", 502, { stage: "create", created: "unknown", retrySafe: false });
    const documentPath = `${DOCUMENT}(guid'${catalog.guid(created.Ref_Key)}')`;
    console.log(`[Счёт] Создан документ ${created.Number || ""}, Ref_Key=${created.Ref_Key}; проведение`);
    let stage = "post";
    try {
        await oneC.post(`${documentPath}/Post()`, {});
        stage = "verify";
        const { data } = await oneC.get(documentPath, { params: { $format: "json" } });
        const result = documentSummary(data?.d || data);
        if (!result.posted) throw new AppError("1С вернула Posted=false после проведения", 502);
        console.log(`[Счёт] Проведён документ ${result.number}, сумма=${result.amount}, Ref_Key=${result.Ref_Key}; Posted подтверждён чтением из 1С`);
        return { ...result, status: "posted" };
    } catch (error) {
        throw new AppError(`Счёт создан, но проведение не подтверждено: ${error.message}`, error.status || 502, {
            ...error.details, ...documentSummary(created), posted: null, created: true, stage, status: "posting_unconfirmed", retrySafe: false,
            hint: "Проверьте документ по Ref_Key в 1С. Повторный create-invoice создаст другой счёт.",
        });
    }
}

function testResult(result) {
    return { Number: result.number, Date: result.date, Сумма: result.amount, Posted: result.posted, Ref_Key: result.Ref_Key };
}
async function testCreateInvoice(options = {}) {
    if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "dryRun")) {
        throw new AppError("Тест использует фиксированные реквизиты; допускается только поле dryRun");
    }
    const dryRun = options.dryRun ?? false;
    if (typeof dryRun !== "boolean") throw new AppError("dryRun должен быть boolean");
    const input = {
        clientName: "ТОРГОВЫЕ РЕШЕНИЯ ООО",
        // Договор покупателя из успешно проведённого ИНБП-000855; принадлежность проверяется заново.
        contractRef: "c2f2a205-c0d4-4d82-afee-9edf26509515",
        productName: "Фискальный накопитель на 15 месяцев",
        quantity: 1, price: 12200, vatRate: 22, priceIncludesVat: true, dryRun,
    };
    if (dryRun) return createInvoice(input);

    // Эксклюзивный журнал сохраняется после перезапуска: повторный тест не создаст второй счёт.
    const stateFile = process.env.ONEC_TEST_STATE_FILE || path.join(__dirname, "tmp", "test-invoice-state.json");
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const state = { status: "running", startedAt: new Date().toISOString(), comment: `Боевой тест API /test-create-invoice ${randomUUID()}` };
    try {
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { flag: "wx" });
    } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let previous;
        try { previous = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { /* Незавершённая запись блокирует повтор. */ }
        if (previous?.status === "completed") {
            console.log(`[Тест] Счёт уже создан: ${previous.result.Ref_Key}; читаем существующий документ`);
            const { data } = await oneC.get(`${DOCUMENT}(guid'${catalog.guid(previous.result.Ref_Key)}')`, { params: { $format: "json" } });
            return testResult(documentSummary(data?.d || data));
        }
        throw new AppError("Тест уже запущен или его результат требует проверки в 1С; повторное создание заблокировано", 409,
            { ...previous, retrySafe: false });
    }
    try {
        const result = testResult(await createInvoice({ ...input, comment: state.comment }));
        fs.writeFileSync(stateFile, JSON.stringify({ ...state, status: "completed", result }, null, 2));
        return result;
    } catch (error) {
        // Только ошибки подготовки заведомо не могли создать документ.
        if (error.details?.stage === "prepare") {
            fs.unlinkSync(stateFile);
        } else {
            fs.writeFileSync(stateFile, JSON.stringify({ ...state, status: "unconfirmed", error: error.message, details: error.details }, null, 2));
        }
        throw error;
    }
}

module.exports = { findClient: catalog.findClient, findProduct: catalog.findProduct, findContracts: catalog.findContracts, previewInvoice, createInvoice, testCreateInvoice, calculate, prepareInvoice, createPreparedInvoice };
