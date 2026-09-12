const { AppError } = require("./errors");
const invoiceService = require("./invoice-service");
const catalog = require("./catalog-service");
const { guid } = catalog;
const { redact } = require("./onec-client");

const EXAMPLE = "Выставь счёт ООО Торговые решения. Фискальный накопитель на 15 месяцев. Цена 12200. НДС 22";
function parseInvoiceText(text) {
    if (typeof text !== "string" || !text.trim() || text.length > 2000) {
        throw new AppError("text: нужна непустая строка до 2000 символов", 400, { example: EXAMPLE });
    }
    const parsed = { quantity: 1, priceIncludesVat: true };
    const labels = { clientName: "название контрагента", productName: "название товара", price: "цена", vatRate: "ставка НДС", quantity: "количество", contractName: "договор" };
    const seen = new Set();
    const assign = (field, value) => {
        if (seen.has(field)) throw new AppError(`В тексте несколько значений: ${labels[field]}; уточните запрос`, 400, { field });
        seen.add(field);
        parsed[field] = value;
    };
    const number = "(?:\\d{1,3}(?:[ .]\\d{3})+|\\d+)(?:[.,]\\d{1,2})?";
    const currency = "(?:руб(?:лей|ля|ль)?|р|₽)(?!\\p{L})";
    const boundary = "(?<![\\p{L}\\p{N}.,+\\-])";
    const decimal = value => value.replace(/ /g, "").replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".");
    let rest = text.normalize("NFKC");
    // Сначала извлекаем явно обозначенные суммы/ставки независимо от пунктуации.
    rest = rest.replace(new RegExp(`${boundary}(?:без\\s*ндс|(?:с\\s+ндс|ндс|ставка(?:\\s+ндс)?)\\s*[:=]?\\s*\\d+\\s*%?|\\d+\\s*%)(?![\\p{L}\\p{N}]|[.,]\\d)(?:\\s+(?:сверху|в цене|включ[её]н))?`, "giu"), value => {
        assign("vatRate", /^без/iu.test(value) ? "БезНДС" : Number(value.match(/\d+/u)[0]));
        parsed.priceIncludesVat = !/сверху$/iu.test(value);
        return ";";
    });
    rest = rest.replace(new RegExp(`${boundary}(?:(?:цена|за)\\s*[:=]?\\s*${number}(?:\\s*${currency})?|${number}\\s*${currency})(?![\\p{L}\\p{N}]|[.,]\\d)`, "giu"), value => {
        assign("price", decimal(value.match(new RegExp(number, "u"))[0]));
        return ";";
    });
    // Запятая между цифрами — десятичный разделитель; в остальных местах — граница поля.
    const clauses = rest.split(/(?<!\d)[.,]|[.,](?!\d)|[;\n]+/u).map(s => s.trim()).filter(Boolean);
    for (let clause of clauses) {
        let match;
        if (new RegExp(`^${number}$`, "u").test(clause)) {
            assign("price", decimal(clause));
        } else if ((match = clause.match(/^(?:количество|кол-во)\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*(?:шт(?:ук[аи]?)?)?$/iu)) || (match = clause.match(/^(\d+(?:[.,]\d+)?)\s*шт(?:ук[аи]?)?$/iu))) {
            assign("quantity", match[1].replace(",", "."));
        } else if ((match = clause.match(/^договор(?:\s*:\s*|\s+)(.+)$/iu))) {
            assign("contractName", match[1].trim());
        } else if ((match = clause.match(/^(?:товар|номенклатура)(?:\s*:\s*|\s+)(.+)$/iu))) {
            assign("productName", match[1].trim());
        } else if ((match = clause.match(/^(?:клиент|контрагент)(?:\s*:\s*|\s+)(.+)$/iu))) {
            assign("clientName", match[1].trim());
        } else {
            if (/^(?:цена|за|ндс|ставка|количество|кол-во|договор|скидка|без\s+ндс)(?:\s|:|$)/iu.test(clause)) {
                throw new AppError(`Не удалось определить значение: «${clause}». Укажите цену числом и ставку НДС, например «Цена 12200. НДС 22»`, 400, { example: EXAMPLE });
            }
            if (!seen.has("clientName")) {
                clause = clause.replace(/^(?:(?:выставь(?:те)?|создай(?:те)?|сформируй(?:те)?)\s+)?сч[её]т\s+(?:для\s+)?/iu, "");
                // Только первое «на» отделяет клиента; «на 15 месяцев» остаётся частью товара.
                const inline = clause.match(/^(.+?)\s+на\s+(.+)$/iu);
                assign("clientName", inline ? inline[1].trim() : clause);
                if (inline) assign("productName", inline[2].trim());
            } else if (!seen.has("productName")) {
                assign("productName", clause);
            } else {
                throw new AppError(`Не удалось однозначно разобрать фрагмент: «${clause}»`, 400, { example: EXAMPLE });
            }
        }
    }
    const missing = ["clientName", "productName", "price", "vatRate"].filter(field => !seen.has(field));
    if (missing.length) throw new AppError(missing.length === 1 && missing[0] === "price" ? "Не указана цена" : `В тексте не найдены: ${missing.map(field => labels[field]).join(", ")}`, 400, { missing, example: EXAMPLE });
    // Положение ООО/ИП в справочнике может отличаться от обычной речи.
    parsed.clientName = parsed.clientName.replace(/[«»"“”]/gu, "").trim()
        .replace(/^(?:ООО|ОАО|ЗАО|ПАО|АО|ИП)\s+/iu, "")
        .replace(/\s+(?:ООО|ОАО|ЗАО|ПАО|АО|ИП)$/iu, "").trim();
    if (!parsed.clientName) throw new AppError("Укажите название клиента после организационной формы", 400);
    const amounts = invoiceService.calculate(parsed);
    return { ...parsed, quantity: amounts.quantity, price: amounts.price };
}

function selectCandidate(candidates, selectedRef, field, label) {
    if (!candidates.length) throw new AppError(`${label} не найден`, 404, { field, candidates: [] });
    if (selectedRef !== undefined) {
        const ref = guid(selectedRef, field);
        const selected = candidates.find(item => item.ref.toLowerCase() === ref);
        if (!selected) throw new AppError(`Выбранный ${label.toLowerCase()} не соответствует тексту или клиенту`, 422, { field, candidates });
        return selected;
    }
    if (candidates.length !== 1) throw new AppError(`Найдено несколько вариантов: ${label.toLowerCase()}. Укажите ${field}`, 409, { field, candidates });
    return candidates[0];
}
async function resolveTextRequest(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Ожидается JSON-объект с text", 400);
    const allowed = ["text", "clientRef", "productRef", "contractRef", "dryRun"];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError(`Допускаются только поля: ${allowed.join(", ")}`, 400);
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") throw new AppError("dryRun должен быть boolean", 400);
    for (const field of ["clientRef", "productRef", "contractRef"]) if (body[field] !== undefined) guid(body[field], field);
    console.log(`[Текст] Пользователь: ${redact(JSON.stringify(body.text))}`);
    const parsed = parseInvoiceText(body.text);
    const client = selectCandidate(await catalog.findClient(parsed.clientName), body.clientRef, "clientRef", "Клиент");
    let products = await catalog.findProduct(parsed.productName);
    const shortProduct = parsed.productName.match(/^ФН\s+(?:на\s+)?(\d+)\s+месяц(?:ев|а)?$/iu);
    if (!products.length && shortProduct) {
        products = await catalog.findProduct(`Фискальный накопитель на ${shortProduct[1]} месяцев`);
    }
    const product = selectCandidate(products, body.productRef, "productRef", "Товар");
    const contracts = (await catalog.findContracts(client.ref, parsed.contractName))
        .filter(item => item.type === "СПокупателем" && !item.closed);
    const contract = selectCandidate(contracts, body.contractRef, "contractRef", "Договор");
    console.log(`[Текст] Запрос разобран: клиент=${client.ref}, товар=${product.ref}, договор=${contract.ref}`);
    return { ...parsed, clientRef: client.ref, productRef: product.ref, contractRef: contract.ref, dryRun: body.dryRun ?? false };
}
async function previewFromText(body) {
    return invoiceService.previewInvoice(await resolveTextRequest(body));
}
async function createFromText(body) {
    const result = await invoiceService.createInvoice(await resolveTextRequest(body));
    if (result.dryRun) return result;
    return { Number: result.number, Date: result.date, Сумма: result.amount, Posted: result.posted, Ref_Key: result.Ref_Key };
}

module.exports = { parseInvoiceText, previewFromText, createFromText, resolveTextRequest };
