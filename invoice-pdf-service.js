const { oneC } = require("./onec-client");
const { guid } = require("./catalog-service");
const { AppError } = require("./errors");
const { signPdfUrl } = require("./pdf-access");
const { renderInvoice } = require("./invoice-template");

const documentEntity = "Document_СчетНаОплатуПокупателю";
function pdfUrl(ref) {
    const base = new URL(process.env.PUBLIC_BASE_URL || "https://api.scheta.online");
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("PUBLIC_BASE_URL должен быть HTTP(S)-адресом без авторизации и параметров");
    }
    return signPdfUrl(`${base.href.replace(/\/+$/, "")}/invoice/${guid(ref)}/pdf`, ref);
}

async function readEntity(entity, ref, navigation, select) {
    try {
        const { data } = await oneC.get(`${entity}(guid'${guid(ref)}')${navigation ? `/${navigation}` : ""}`, { params: { $format: "json", ...(select ? { $select: select } : {}) } });
        const row = data?.d || data;
        if (!row?.Ref_Key || row.DeletionMark) throw new AppError("Документ или реквизиты не найдены в 1С", 404);
        return row;
    } catch (error) {
        if (error.details?.upstreamStatus === 404) throw new AppError("Документ или реквизиты не найдены в 1С", 404);
        throw error;
    }
}

async function loadInvoice(ref) {
    const document = await readEntity(documentEntity, ref);
    if (document.Posted !== true) throw new AppError("PDF доступен только для проведённого счёта", 409);
    if (!document.Number || !document.Date || !Array.isArray(document.Товары) || !document.Товары.length) {
        throw new AppError("1С вернула неполные данные счёта для PDF", 502);
    }
    // Читаем последовательно: при параллельной проверке этой базы наблюдались тайм-ауты.
    const organization = await readEntity("Catalog_Организации", document.Организация_Key);
    const client = await readEntity("Catalog_Контрагенты", document.Контрагент_Key);
    const contract = await readEntity("Catalog_ДоговорыКонтрагентов", document.ДоговорКонтрагента_Key);
    const currency = await readEntity("Catalog_Валюты", document.ВалютаДокумента_Key);
    const usableRef = value => value && value !== "00000000-0000-0000-0000-000000000000";
    const bankRef = usableRef(document.СтруктурнаяЕдиница_Key) ? document.СтруктурнаяЕдиница_Key : organization.ОсновнойБанковскийСчет_Key;
    if (!usableRef(bankRef)) throw new AppError("Не указан банковский счёт организации для PDF", 422);
    const account = await readEntity("Catalog_БанковскиеСчета", bankRef);
    if ((account.Owner || account.Owner_Key)?.toLowerCase() !== organization.Ref_Key.toLowerCase()) throw new AppError("Банковский счёт не принадлежит организации документа", 422);
    const bankRow = await readEntity("Catalog_БанковскиеСчета", bankRef, "Банк");
    const bank = { account: account.НомерСчета, name: [bankRow.Description, bankRow.Город].filter(Boolean).join(" "), bic: bankRow.Code, correspondent: bankRow.КоррСчет };
    const directorRef = usableRef(document.Руководитель_Key) ? document.Руководитель_Key : undefined;
    let directorName;
    if (directorRef) {
        const director = await readEntity("Catalog_ФизическиеЛица", directorRef, undefined, "Ref_Key,Description,Фамилия,Инициалы");
        directorName = [director.Фамилия, director.Инициалы].filter(Boolean).join(" ") || director.Description;
    }
    const items = [];
    for (const row of document.Товары) {
        if ([row.Количество, row.Цена, row.СуммаНДС, row.Сумма, document.СуммаДокумента]
            .some(value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) || !row.СтавкаНДС) {
            throw new AppError("1С вернула неполные суммы или ставку НДС для PDF", 502);
        }
        const name = row.Содержание || (await readEntity("Catalog_Номенклатура", row.Номенклатура || row.Номенклатура_Key)).Description;
        items.push({ name, quantity: row.Количество, price: row.Цена, vat: row.СтавкаНДС, vatAmount: row.СуммаНДС, lineAmount: row.Сумма, unit: row.ЕдиницаИзмеренияНаименование || "шт",
            total: document.СуммаВключаетНДС ? row.Сумма : (Math.round(Number(row.Сумма) * 100) + Math.round(Number(row.СуммаНДС) * 100)) / 100 });
    }
    return { number: document.Number, date: document.Date, organization, client, contract, currency, bank, directorRef, directorName,
        items, total: document.СуммаДокумента, priceIncludesVat: document.СуммаВключаетНДС };
}

async function generatePdf(ref) {
    const invoice = await loadInvoice(guid(ref, "id"));
    const buffer = await renderInvoice(invoice);
    const safeNumber = String(invoice.number).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_");
    return { buffer, filename: `Счет_${safeNumber}.pdf` };
}

module.exports = { pdfUrl, loadInvoice, renderInvoice, generatePdf };
