const PDFDocument = require("pdfkit");
const path = require("node:path");
const { oneC } = require("./onec-client");
const { guid } = require("./catalog-service");
const { AppError } = require("./errors");
const { signPdfUrl } = require("./pdf-access");

const font = path.join(__dirname, "assets", "fonts", "NotoSans.ttf");
const documentEntity = "Document_СчетНаОплатуПокупателю";
function pdfUrl(ref) {
    const base = new URL(process.env.PUBLIC_BASE_URL || "https://api.scheta.online");
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new Error("PUBLIC_BASE_URL должен быть HTTP(S)-адресом без авторизации и параметров");
    }
    return signPdfUrl(`${base.href.replace(/\/+$/, "")}/invoice/${guid(ref)}/pdf`, ref);
}

async function readEntity(entity, ref) {
    try {
        const { data } = await oneC.get(`${entity}(guid'${guid(ref)}')`, { params: { $format: "json" } });
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
    const items = [];
    for (const row of document.Товары) {
        if ([row.Количество, row.Цена, row.СуммаНДС, row.Сумма, document.СуммаДокумента]
            .some(value => value === null || value === undefined || value === "" || !Number.isFinite(Number(value))) || !row.СтавкаНДС) {
            throw new AppError("1С вернула неполные суммы или ставку НДС для PDF", 502);
        }
        const name = row.Содержание || (await readEntity("Catalog_Номенклатура", row.Номенклатура || row.Номенклатура_Key)).Description;
        items.push({ name, quantity: row.Количество, price: row.Цена, vat: row.СтавкаНДС, vatAmount: row.СуммаНДС,
            total: document.СуммаВключаетНДС ? row.Сумма : (Math.round(Number(row.Сумма) * 100) + Math.round(Number(row.СуммаНДС) * 100)) / 100 });
    }
    return { number: document.Number, date: document.Date, organization, client, contract, currency,
        items, total: document.СуммаДокумента, priceIncludesVat: document.СуммаВключаетНДС };
}

function renderInvoice(invoice) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 45, info: { Title: `Счёт ${invoice.number}`, Author: "1C Chat API" } });
        const chunks = [];
        doc.on("data", chunk => chunks.push(chunk));
        doc.on("error", reject);
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        try {
            doc.font(font).fontSize(18).text(`Счёт № ${invoice.number}`);
            doc.fontSize(11).text(`Дата: ${invoice.date.slice(0, 10).split("-").reverse().join(".")}`).moveDown();
            const party = row => `${row.НаименованиеПолное || row.Description}${row.ИНН ? `, ИНН ${row.ИНН}` : ""}${row.КПП ? `, КПП ${row.КПП}` : ""}`;
            doc.text(`Организация: ${party(invoice.organization)}`).moveDown(0.5);
            doc.text(`Клиент: ${party(invoice.client)}`).moveDown(0.5);
            doc.text(`Договор: ${invoice.contract.Description}${invoice.contract.Номер ? `, № ${invoice.contract.Номер}` : ""}`).moveDown(0.5);
            doc.text(`Валюта: ${invoice.currency.Description}`).moveDown();
            const money = value => Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
            invoice.items.forEach((item, index) => {
                if (doc.y > 620) doc.addPage();
                doc.fontSize(12).text(`${index + 1}. ${item.name}`).fontSize(10).moveDown(0.3);
                doc.text(`Количество: ${item.quantity}    Цена: ${money(item.price)}`);
                const vat = item.vat === "БезНДС" ? "Без НДС" : String(item.vat).replace(/^НДС/, "") + "%";
                doc.text(`НДС: ${vat}    Сумма НДС: ${money(item.vatAmount)}    Итого: ${money(item.total)}`).moveDown();
            });
            doc.fontSize(12).text(`Сумма НДС: ${money(invoice.items.reduce((sum, item) => sum + Math.round(Number(item.vatAmount) * 100), 0) / 100)}`);
            doc.fontSize(15).text(`Всего к оплате: ${money(invoice.total)}`).moveDown(0.5);
            doc.fontSize(9).text(invoice.priceIncludesVat ? "НДС включён в цену." : "НДС начислен сверх цены.");
            doc.end();
        } catch (error) { doc.destroy(); reject(error); }
    });
}

async function generatePdf(ref) {
    const invoice = await loadInvoice(guid(ref, "id"));
    const buffer = await renderInvoice(invoice);
    const safeNumber = String(invoice.number).replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, "_");
    return { buffer, filename: `Счет_${safeNumber}.pdf` };
}

module.exports = { pdfUrl, loadInvoice, renderInvoice, generatePdf };
