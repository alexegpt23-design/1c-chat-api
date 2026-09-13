const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");
const path = require("node:path");
const { AppError } = require("./errors");
const template = require("./assets/templates/invoice-587.json");

function form(n, words) { return words[n % 100 >= 11 && n % 100 <= 14 ? 2 : n % 10 === 1 ? 0 : n % 10 >= 2 && n % 10 <= 4 ? 1 : 2]; }
function triad(n, feminine) {
    const units = feminine ? ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"] : ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
    const hundreds = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
    const teens = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
    const tens = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
    return [hundreds[Math.floor(n / 100)], ...(n % 100 >= 10 && n % 100 < 20 ? [teens[n % 100 - 10]] : [tens[Math.floor(n % 100 / 10)], units[n % 10]])].filter(Boolean).join(" ");
}
function amountInWords(value, currency = "RUB") {
    const cents = Math.round(Number(value) * 100);
    if (!Number.isSafeInteger(cents) || cents < 0 || cents > 1000000000000) throw new AppError("Недопустимая сумма для печати", 502);
    let whole = Math.floor(cents / 100);
    const original = whole, parts = [];
    const groups = [null, ["тысяча", "тысячи", "тысяч"], ["миллион", "миллиона", "миллионов"], ["миллиард", "миллиарда", "миллиардов"]];
    for (let group = 0; whole; group++, whole = Math.floor(whole / 1000)) {
        const n = whole % 1000;
        if (n) parts.unshift(triad(n, group === 1) + (group ? " " + form(n, groups[group]) : ""));
    }
    const names = currency === "USD" ? [["доллар США", "доллара США", "долларов США"], ["цент", "цента", "центов"]] : currency === "EUR" ? [["евро", "евро", "евро"], ["евроцент", "евроцента", "евроцентов"]] : [["рубль", "рубля", "рублей"], ["копейка", "копейки", "копеек"]];
    if (!["RUB", "USD", "EUR"].includes(currency)) throw new AppError("Валюта не поддерживается шаблоном суммы прописью", 422);
    const result = `${parts.join(" ") || "ноль"} ${form(original, names[0])} ${String(cents % 100).padStart(2, "0")} ${form(cents % 100, names[1])}`;
    return result[0].toUpperCase() + result.slice(1);
}
const money = value => Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = value => value.slice(0, 10).split("-").reverse().join(".");
const fullName = row => row.НаименованиеПолное || row.Description || "";
function currencyCode(row) {
    const code = String(row.Code || row.Код || "");
    if (["643", "810", "RUB"].includes(code) || /руб|RUB/i.test(row.Description || "")) return "RUB";
    if (code === "840" || /USD|доллар/i.test(row.Description || "")) return "USD";
    if (code === "978" || /EUR|евро/i.test(row.Description || "")) return "EUR";
    return code;
}
function paymentPayload(invoice) {
    if (currencyCode(invoice.currency) !== "RUB") return null;
    const bank = invoice.bank;
    if (!bank || !/^\d{20}$/.test(bank.account) || !/^\d{9}$/.test(bank.bic) || !/^\d{20}$/.test(bank.correspondent) || !bank.name || !/^\d{10}(?:\d{2})?$/.test(invoice.organization.ИНН || "")) {
        throw new AppError("Не заполнены банковские реквизиты организации для PDF", 422);
    }
    const clean = value => String(value).replace(/[|\r\n]/g, " ");
    const fields = { Name: fullName(invoice.organization).slice(0, 160), PersonalAcc: bank.account, BankName: bank.name.slice(0, 45), BIC: bank.bic, CorrespAcc: bank.correspondent, PayeeINN: invoice.organization.ИНН,
        ...(invoice.organization.КПП ? { KPP: invoice.organization.КПП } : {}), Sum: String(Math.round(Number(invoice.total) * 100)), Purpose: `Оплата по счету № ${invoice.number} от ${shortDate(invoice.date)}` };
    return "ST00012|" + Object.entries(fields).map(([key, value]) => key + "=" + clean(value)).join("|");
}
function party(row) {
    const contacts = row.КонтактнаяИнформация || [];
    const address = contacts.find(item => item.Тип === "Адрес")?.Представление;
    const phone = contacts.find(item => item.Тип === "Телефон")?.Представление;
    return [fullName(row), row.ИНН && `ИНН ${row.ИНН}`, row.КПП && `КПП ${row.КПП}`, address, phone && `тел.: ${phone}`].filter(Boolean).join(", ");
}

async function renderInvoice(invoice) {
    const words = amountInWords(invoice.total, currencyCode(invoice.currency));
    const payment = paymentPayload(invoice);
    const qr = payment ? await QRCode.toBuffer(payment, { errorCorrectionLevel: "M", margin: 4, scale: 5 }) : null;
    const branded = invoice.organization.ИНН === template.organizationInn;
    const signed = branded && (!invoice.directorRef || invoice.directorRef === template.directorRef);
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: [595.32, 841.92], margins: { top: 35, bottom: 35, left: 34, right: 34 }, info: { Title: `Счет на оплату № ${invoice.number}`, Author: fullName(invoice.organization) } });
        const chunks = [];
        doc.on("data", chunk => chunks.push(chunk)); doc.on("error", reject); doc.on("end", () => resolve(Buffer.concat(chunks)));
        try {
            doc.registerFont("Regular", path.join(__dirname, "assets/fonts/NotoSans.ttf"));
            doc.registerFont("Bold", path.join(__dirname, "assets/fonts/NotoSans-Bold.ttf"));
            const txt = (text, x, y, width, size = 9, bold = false, options = {}) => {
                doc.font(bold ? "Bold" : "Regular").fontSize(size).fillColor("black").text(String(text), x, y, { width, lineGap: 0, ...options });
                return doc.y;
            };
            const line = (x1, y1, x2, y2, weight = 0.6) => doc.lineWidth(weight).strokeColor("#333333").moveTo(x1, y1).lineTo(x2, y2).stroke();
            const art = (name, x, y, width) => doc.image(Buffer.from(template.artwork[name].png, "base64"), x, y, { width });
            // Координаты шапки повторяют исходный A4: логотип слева, реквизиты и QR справа.
            if (branded) art("logo", 34.32, 82.32, 86.28);
            const left = 127, top = 50, right = 528, bottom = 146;
            doc.lineWidth(0.6).rect(left, top, right - left, bottom - top).stroke();
            for (const x of [313, 348, 454]) line(x, top, x, bottom);
            line(left, 95, 454, 95); line(left, 110, 313, 110); line(227, 95, 227, 110); line(313, 65, 454, 65);
            txt(invoice.bank?.name || "", 129, 51, 180, 8.5);
            txt("Банк получателя", 129, 84, 180, 7.5);
            txt("БИК", 315, 51, 30, 9); txt(invoice.bank?.bic || "", 350, 51, 102, 8.5);
            txt("Сч. №", 315, 66, 32, 9); txt(invoice.bank?.correspondent || "", 350, 66, 102, 8.3);
            txt(`ИНН   ${invoice.organization.ИНН || ""}`, 129, 96, 96, 8.2);
            txt(`КПП   ${invoice.organization.КПП || ""}`, 229, 96, 82, 8.2);
            txt("Сч. №", 315, 96, 32, 9); txt(invoice.bank?.account || "", 350, 96, 102, 8.3);
            txt(fullName(invoice.organization), 129, 111, 182, 8.3, false, { height: 27 });
            txt("Получатель", 129, 136, 180, 7.5);
            if (qr) { doc.image(qr, 455, 50, { width: 72, height: 72 }); txt("Отсканируйте для\nоплаты", 455, 124, 72, 7.4, false, { align: "center" }); }
            const date = new Date(invoice.date.slice(0, 10) + "T12:00:00Z").toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
            let y = txt(`Счет на оплату № ${invoice.number} от ${date}`, 36, 159, 481, 13, true) + 9;
            line(34, y, 516, y, 1.3); y += 7;
            for (const [label, value] of [["Поставщик\n(Исполнитель):", party(invoice.organization)], ["Покупатель\n(Заказчик):", party(invoice.client)]]) {
                const labelEnd = txt(label, 36, y, 71, 9);
                const valueEnd = txt(value, 109, y, 407, 9, true);
                y = Math.max(labelEnd, valueEnd) + 9;
            }
            txt("Основание:", 36, y, 71, 9);
            const basis = invoice.contract?.Description ? `${invoice.contract.Description}${invoice.contract.Номер ? ` № ${invoice.contract.Номер}` : ""}; счет ${invoice.number} от ${shortDate(invoice.date)}` : `Счет ${invoice.number} от ${shortDate(invoice.date)}`;
            y = txt(basis, 109, y, 407, 9, true) + 8;
            const columns = [34, 58, 303, 344, 375, 441, 516];
            const row = (values, height, bold = false) => {
                doc.lineWidth(bold ? 1.2 : 0.6).rect(34, y, 482, height).stroke();
                for (const x of columns.slice(1, -1)) line(x, y, x, y + height);
                values.forEach((value, i) => txt(value, columns[i] + 2, y + 1, columns[i + 1] - columns[i] - 4, bold ? 8.5 : 7.7, bold, { align: bold || i === 0 ? "center" : i === 1 || i === 3 ? "left" : "right" }));
                y += height;
            };
            const header = () => row(["№", "Товары (работы, услуги)", "Кол-во", "Ед.", "Цена", "Сумма"], 14, true);
            header();
            invoice.items.forEach((item, index) => {
                const height = Math.max(13, doc.font("Regular").fontSize(7.7).heightOfString(item.name, { width: 241 }) + 3);
                if (height > 650) throw new AppError("Слишком длинное наименование товара для PDF", 422);
                if (y + height > 760) { doc.addPage(); y = txt(`Счет № ${invoice.number} — продолжение`, 34, 35, 482, 11, true) + 10; header(); }
                row([index + 1, item.name, item.quantity, item.unit || "шт", money(item.price), money(item.lineAmount ?? item.total)], height);
            });
            // Итоги, условия и факсимиле переносятся единым блоком на последнюю страницу.
            if (y + 340 + (new Set(invoice.items.map(item => item.vat)).size - 1) * 13 > 805) { doc.addPage(); y = txt(`Счет № ${invoice.number} — итоги`, 34, 35, 482, 11, true) + 12; }
            y += 8;
            const totals = [["Итого:", invoice.items.reduce((sum, item) => sum + Math.round(Number(item.lineAmount ?? item.total) * 100), 0) / 100]];
            const vatGroups = new Map();
            for (const item of invoice.items) vatGroups.set(item.vat, (vatGroups.get(item.vat) || 0) + Math.round(Number(item.vatAmount) * 100));
            for (const [rate, cents] of vatGroups) totals.push([rate === "БезНДС" ? "Без НДС" : `${invoice.priceIncludesVat ? "В том числе " : ""}НДС ${String(rate).replace(/^НДС/, "")}%:`, cents / 100]);
            totals.push(["Всего к оплате:", invoice.total]);
            for (const [label, value] of totals) { txt(label, 265, y, 174, 9, true, { align: "right" }); txt(money(value), 442, y, 72, 9, true, { align: "right" }); y += 13; }
            y += 1;
            y = txt(`Всего наименований ${invoice.items.length}, на сумму ${money(invoice.total)} ${invoice.currency.Description}`, 36, y, 480, 9) + 2;
            y = txt(words, 36, y, 480, 9, true) + 12;
            y = txt("Внимание!\nОплата данного счета означает согласие с условиями поставки товара.\nУведомление об оплате обязательно, в противном случае не гарантируется наличие товара на складе.\nТовар отпускается по факту прихода денег на р/с Поставщика, самовывозом, при наличии доверенности и паспорта.", 36, y, 480, 8.2) + 8;
            line(34, y, 516, y, 1.2); y += 22;
            txt("Руководитель", 36, y, 79, 9, true); line(117, y + 12, 300, y + 12);
            if (signed) art("signature", 120.6, y - 16, 87.48);
            txt(invoice.directorName || (signed ? template.director : ""), 222, y + 2, 78, 7.5, false, { align: "right" });
            txt("Бухгалтер", 318, y, 64, 9, true); line(381, y + 12, 516, y + 12);
            if (branded) art("seal", 54.6, y + 34, 125.76);
            doc.end();
        } catch (error) { doc.destroy(); reject(error); }
    });
}

module.exports = { renderInvoice, amountInWords, paymentPayload, currencyCode };
