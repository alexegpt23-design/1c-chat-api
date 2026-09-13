const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../errors");
const { parseInvoiceText, resolveTextRequest } = require("../invoice-text-service");
const { buildCounterpartyDocument } = require("../counterparty-search-service");
const { createCounterpartyResolver } = require("../counterparty-resolution-service");

const ref = digit => `00000000-0000-0000-0000-${String(digit).padStart(12, "0")}`;
const tradingRow = {
    Ref_Key: ref(1), DataVersion: "v1", Code: "1",
    Description: "ТОРГОВЫЕ РЕШЕНИЯ ООО",
    НаименованиеПолное: 'Общество с ограниченной ответственностью "Торговые решения"',
    ИНН: "7701234567", DeletionMark: false, IsFolder: false,
};
const trading = buildCounterpartyDocument(tradingRow);
const quietLog = { log() {}, warn() {} };

test("parser сохраняет прежний clientName contract", () => {
    const parsed = parseInvoiceText("Выставь счёт ООО ГИПЕР на фн 15, 1 штука, 12400 рублей, НДС 22%");
    assert.equal(parsed.clientName, "ГИПЕР");
    assert.equal(parsed.productName, "фн 15");
});


test("resolver получает исходные склонения и юрформу во всех позициях", async () => {
    const queries = [
        "торговым решениям",
        "ООО торговые решения",
        "торговые решения ООО",
        "торговые ООО решения",
        "общество с ограниченной ответственностью торговые решения",
    ];
    for (const expectedQuery of queries) {
        let actualQuery;
        await resolveTextRequest({
            text: `Выставь счёт ${expectedQuery} на фн 15, 1 штука, 12400 рублей, НДС 22%`,
        }, {
            catalog: {
                findContracts: async () => [{ ref: ref(4), name: "Основной", type: "СПокупателем", closed: false }],
            },
            counterpartyResolver: {
                resolveByText: async query => {
                    actualQuery = query;
                    return { candidates: [{ ref: trading.ref, name: trading.name }] };
                },
            },
            productResolver: {
                resolveByText: async () => ({ candidates: [{ ref: ref(3), name: "фн 15" }] }),
            },
        });
        assert.equal(actualQuery, expectedQuery);
    }
});

test("normalized selected перечитывается из 1С и возвращает актуальную карточку", async () => {
    let resolves = 0;
    const catalog = {
        resolve: async (kind, value) => {
            resolves++;
            assert.deepEqual([kind, value], ["client", trading.ref]);
            return { ...tradingRow, Description: "АКТУАЛЬНОЕ ИМЯ ООО" };
        },
        summary: (_kind, row) => ({ ref: row.Ref_Key, name: row.Description, inn: row.ИНН }),
        findClient: async () => { throw new Error("fallback не ожидается"); },
    };
    const resolver = createCounterpartyResolver({
        catalog, buildIndex: async () => ({ counterparties: [trading] }), log: quietLog,
    });
    const result = await resolver.resolveByText("торговым решениям");
    assert.equal(resolves, 1);
    assert.equal(result.mode, "normalized");
    assert.deepEqual(result.candidates, [{ ref: trading.ref, name: "АКТУАЛЬНОЕ ИМЯ ООО", inn: "7701234567" }]);
});

test("ambiguous возвращает 409 clientRef и не запускает OData fallback", async () => {
    let fallbackCalls = 0;
    const second = buildCounterpartyDocument({ ...tradingRow, Ref_Key: ref(2), Description: "Торговые решения ИП", НаименованиеПолное: "ИП Торговые решения" });
    const resolver = createCounterpartyResolver({
        catalog: { findClient: async () => { fallbackCalls++; return []; } },
        buildIndex: async () => ({ counterparties: [trading, second] }),
        log: quietLog,
    });
    await assert.rejects(
        resolver.resolveByText("торговые решения"),
        error => error instanceof AppError && error.status === 409
            && error.details.field === "clientRef"
            && error.details.candidates.every(item => Object.keys(item).sort().join(",") === "name,ref"),
    );
    assert.equal(fallbackCalls, 0);
});

test("not_found использует старый OData fallback", async () => {
    let fallbackCalls = 0;
    const expected = [{ ref: ref(9), name: "Legacy" }];
    const resolver = createCounterpartyResolver({
        catalog: { findClient: async query => { fallbackCalls++; assert.equal(query, "неизвестный"); return expected; } },
        buildIndex: async () => ({ counterparties: [trading] }),
        log: quietLog,
    });
    const result = await resolver.resolveByText("неизвестный");
    assert.equal(result.mode, "odata-fallback");
    assert.deepEqual(result.candidates, expected);
    assert.equal(fallbackCalls, 1);
});

test("индекс кэшируется, refresh атомарный, при ошибке остаётся старая версия", async () => {
    let builds = 0;
    let clock = 0;
    const resolver = createCounterpartyResolver({
        catalog: {
            resolve: async () => tradingRow,
            summary: (_kind, row) => ({ ref: row.Ref_Key, name: row.Description }),
            findClient: async () => [],
        },
        ttlMs: 10,
        now: () => clock,
        buildIndex: async () => {
            builds++;
            if (builds === 2) throw new Error("temporary");
            return { counterparties: [trading] };
        },
        log: quietLog,
    });
    await resolver.resolveByText("торговые решения ООО");
    await resolver.resolveByText("торговые решения ООО");
    assert.equal(builds, 1);
    clock = 11;
    const stale = await resolver.resolveByText("торговые решения ООО");
    assert.equal(stale.candidates[0].ref, trading.ref);
    assert.equal(builds, 2);
});

test("точный clientRef не запускает normalized resolver, product и contract flow сохраняются", async () => {
    let normalizedCalls = 0;
    let productCalls = 0;
    const catalog = {
        findClient: async () => [{ ref: trading.ref, name: trading.name }],
        findProduct: async () => [{ ref: ref(3), name: "фн 15" }],
        findContracts: async () => [{ ref: ref(4), name: "Основной", type: "СПокупателем", closed: false }],
    };
    const result = await resolveTextRequest({
        text: "Выставь счёт ООО торговые решения на фн 15, 1 штука, 12400 рублей, НДС 22%",
        clientRef: trading.ref,
    }, {
        catalog,
        counterpartyResolver: { resolveByText: async () => { normalizedCalls++; return { candidates: [] }; } },
        productResolver: { resolveByText: async () => { productCalls++; return { candidates: [{ ref: ref(3), name: "фн 15" }] }; } },
    });
    assert.equal(normalizedCalls, 0);
    assert.equal(productCalls, 1);
    assert.equal(result.clientRef, trading.ref);
    assert.equal(result.productRef, ref(3));
    assert.equal(result.contractRef, ref(4));
});

test("текстовый client использует normalized resolver, сохраняя product и contract resolver", async () => {
    let normalizedCalls = 0;
    let productCalls = 0;
    const catalog = {
        findContracts: async clientRef => {
            assert.equal(clientRef, trading.ref);
            return [{ ref: ref(4), name: "Основной", type: "СПокупателем", closed: false }];
        },
    };
    const result = await resolveTextRequest({
        text: "Выставь счёт торговым решениям на фн 15, 1 штука, 12400 рублей, НДС 22%",
    }, {
        catalog,
        counterpartyResolver: { resolveByText: async query => {
            normalizedCalls++;
            assert.equal(query, "торговым решениям");
            return { candidates: [{ ref: trading.ref, name: trading.name }] };
        } },
        productResolver: { resolveByText: async () => {
            productCalls++;
            return { candidates: [{ ref: ref(3), name: "фн 15" }] };
        } },
    });
    assert.equal(normalizedCalls, 1);
    assert.equal(productCalls, 1);
    assert.equal(result.clientRef, trading.ref);
    assert.equal(result.contractRef, ref(4));
});
