const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.ONEC_URL = "http://onec.invalid/odata/standard.odata/";
process.env.ONEC_USER = "test-user";
process.env.ONEC_PASSWORD = "test-password";
const { parseInvoiceText } = require("../invoice-text-service");

const cases = [
    ["точка тысяч и с НДС", "Выставь счёт ООО ГИПЕР. Фискальный накопитель на 15 месяцев. 12.200 руб. с НДС 22", "Фискальный накопитель на 15 месяцев", 12200],
    ["рубли без метки цены", "счёт ГИПЕР. Фискальный накопитель на 15 месяцев. 12 200 рублей. 22%", "Фискальный накопитель на 15 месяцев", 12200],
    ["точка тысяч и копейки", "ГИПЕР ООО; ФН 15 месяцев; 12.200,50 руб; НДС 22", "ФН 15 месяцев", 12200.5],
    ["предложения", "Выставь счёт ООО ГИПЕР. Фискальный накопитель на 15 месяцев. Цена 12200. НДС 22", "Фискальный накопитель на 15 месяцев", 12200],
    ["одна строка с за и рублями", "Счёт для ООО ГИПЕР на Фискальный накопитель на 15 месяцев за 12200 рублей НДС 22", "Фискальный накопитель на 15 месяцев", 12200],
    ["короткий список через запятые", "ООО ГИПЕР, ФН 15 месяцев, 12200, НДС 22", "ФН 15 месяцев", 12200],
    ["цена в рублях и процент без НДС", "ГИПЕР ООО, ФН 15 месяцев, 12200 рублей, 22%", "ФН 15 месяцев", 12200],
    ["за и ставка", "Счет для ООО ГИПЕР на ФН 15 месяцев за 12200 ставка 22", "ФН 15 месяцев", 12200],
    ["десятичная запятая и пробел тысяч", "Контрагент: ООО ГИПЕР; Товар: ФН 15 месяцев; Цена 12 200,50; ставка НДС 22%", "ФН 15 месяцев", 12200.5],
    ["десятичная точка и название модели", "Создай счет ООО ГИПЕР. ФН-1.2 на 15 месяцев. 12200.50 рублей. 22%", "ФН-1.2 на 15 месяцев", 12200.5],
    ["кавычки и регистр", "выставьте СЧЕТ ООО «ГИПЕР», ФН 15 месяцев, ЦЕНА 12200, СТАВКА 22", "ФН 15 месяцев", 12200],
];
for (const [label, text, productName, price] of cases) {
    test(`гибкий парсер: ${label}`, () => {
        const parsed = parseInvoiceText(text);
        assert.equal(parsed.clientName, "ГИПЕР");
        assert.equal(parsed.productName, productName);
        assert.equal(parsed.price, price);
        assert.equal(parsed.vatRate, 22);
        assert.equal(parsed.quantity, 1);
    });
}

test("цифры срока и количества не становятся ценой или НДС", () => {
    assert.equal(parseInvoiceText("счёт ГИПЕР; ФН 15 месяцев; 2 шт; 12200; с НДС 22").quantity, 2);
    const parsed = parseInvoiceText("ООО ГИПЕР, ФН 15 месяцев, Количество 2, Цена 12200, НДС 22 сверху");
    assert.equal(parsed.quantity, 2);
    assert.equal(parsed.price, 12200);
    assert.equal(parsed.priceIncludesVat, false);
    assert.throws(() => parseInvoiceText("ООО ГИПЕР, ФН 15 месяцев, НДС 22"), error => {
        assert.equal(error.status, 400);
        assert.deepEqual(error.details.missing, ["price"]);
        assert.match(error.message, /цена/);
        return true;
    });
});
test("отсутствующие поля названы в ошибке 400", () => {
    for (const [text, missing, label] of [
        ["ООО ГИПЕР, ФН 15 месяцев, 12200", "vatRate", "ставка НДС"],
        ["Клиент: ООО ГИПЕР; Цена 12200; НДС 22", "productName", "название товара"],
        ["Товар: ФН 15 месяцев; Цена 12200; НДС 22", "clientName", "название контрагента"],
    ]) {
        assert.throws(() => parseInvoiceText(text), error => {
            assert.equal(error.status, 400);
            assert.ok(error.details.missing.includes(missing));
            assert.ok(error.message.includes(label));
            return true;
        });
    }
});
test("противоречивые ставки, отрицательные и неполные числа отклоняются", () => {
    for (const tail of ["Цена -12200, НДС 22", "Цена 12200, НДС 22.5", "Цена 12200, НДС 22, ставка 10", "за 12200, 13000 рублей, НДС 22", "Цена 12200, НДС -22", "Цена 12200, НДС 22, Скидка 10%"] ) {
        assert.throws(() => parseInvoiceText("ООО ГИПЕР, ФН 15 месяцев, " + tail), { status: 400 });
    }
});
