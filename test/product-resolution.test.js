process.env.COUNTERPARTY_SEARCH_MODE = "odata";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { AppError } = require("../errors");
const { createProductResolver } = require("../product-resolution-service");
const { resolveTextRequest } = require("../invoice-text-service");

const ref = digit => `00000000-0000-0000-0000-${String(digit).padStart(12, "0")}`;
const row = (id, name) => ({
    Ref_Key: ref(id), Description: name, DeletionMark: false, IsFolder: false,
});
function fakeCatalog(options = {}) {
    const resolved = [];
    return {
        resolved,
        resolve: async (_kind, id) => {
            resolved.push(id);
            if (options.missing?.includes(id)) throw new AppError("Не найден product", 404);
            return row(Number(id.slice(-1)), options.names?.[id] || "Актуальный товар");
        },
        summary: (_kind, value) => ({ ref: value.Ref_Key, name: value.Description }),
        findProduct: async query => options.odata || [{ ref: ref(9), name: query }],
    };
}
const silent = { log() {}, warn() {} };

test("hybrid selected перепроверяет Ref_Key через 1С", async () => {
    const catalog = fakeCatalog();
    const resolver = createProductResolver({
        mode: "hybrid", catalog, log: silent,
        workerClient: { search: async () => ({
            decision: "selected", candidate: { ref: ref(1), name: "Старое имя" }, candidates: [],
        }) },
    });
    const result = await resolver.resolveByText("товар");
    assert.deepEqual(catalog.resolved, [ref(1)]);
    assert.equal(result.candidates[0].name, "Актуальный товар");
});

test("hybrid ambiguous возвращает 409 и только реальные поля кандидатов", async () => {
    const catalog = fakeCatalog({ names: { [ref(1)]: "Один", [ref(2)]: "Два" } });
    const resolver = createProductResolver({
        mode: "hybrid", catalog, log: silent,
        workerClient: { search: async () => ({
            decision: "ambiguous", candidate: null,
            candidates: [{ ref: ref(1), score: 999 }, { ref: ref(2), score: 998 }],
        }) },
    });
    await assert.rejects(resolver.resolveByText("товар"), error => {
        assert.equal(error.status, 409);
        assert.equal(error.details.field, "productRef");
        assert.deepEqual(error.details.candidates, [
            { ref: ref(1), name: "Один" }, { ref: ref(2), name: "Два" },
        ]);
        return true;
    });
});

for (const code of ["UNAVAILABLE", "HTTP_ERROR"]) {
    test(`worker ${code} включает lexical fallback`, async () => {
        const catalog = fakeCatalog();
        const resolver = createProductResolver({
            mode: "hybrid", catalog, log: silent,
            workerClient: { search: async () => { const error = new Error("worker"); error.code = code; throw error; } },
            lexicalSearch: () => ({
                decision: "selected", candidate: { ref: ref(3), name: "Lexical" }, candidates: [],
            }),
        });
        const result = await resolver.resolveByText("товар");
        assert.equal(result.mode, "lexical-fallback");
        assert.deepEqual(catalog.resolved, [ref(3)]);
    });
}

test("недоступный local index включает старый OData fallback", async () => {
    const catalog = fakeCatalog({ odata: [{ ref: ref(8), name: "OData" }] });
    const resolver = createProductResolver({
        mode: "hybrid", catalog, log: silent,
        workerClient: { search: async () => { throw new Error("offline"); } },
        lexicalSearch: () => { throw new Error("missing index"); },
    });
    const result = await resolver.resolveByText("товар");
    assert.equal(result.mode, "odata-fallback");
    assert.equal(result.candidates[0].name, "OData");
});

test("lexical fallback ambiguous не выбирает товар автоматически", async () => {
    const catalog = fakeCatalog();
    const resolver = createProductResolver({
        mode: "hybrid", catalog, log: silent,
        workerClient: { search: async () => { throw new Error("offline"); } },
        lexicalSearch: () => ({
            decision: "ambiguous", candidate: null,
            candidates: [{ ref: ref(1) }, { ref: ref(2) }],
        }),
    });
    await assert.rejects(resolver.resolveByText("товар"), error => error.status === 409);
});

test("exact productRef сохраняет legacy поиск; клиент и договор не меняются", async () => {
    const calls = [];
    const clientRef = ref(4), productRef = ref(5), contractRef = ref(6);
    const catalog = {
        findClient: async name => { calls.push(["client", name]); return [{ ref: clientRef, name: "ГИПЕР" }]; },
        findProduct: async name => { calls.push(["product", name]); return [{ ref: productRef, name }]; },
        findContracts: async id => { calls.push(["contract", id]); return [{
            ref: contractRef, name: "Основной", type: "СПокупателем", closed: false,
        }]; },
    };
    const productResolver = { resolveByText: async () => { throw new Error("hybrid не должен вызываться"); } };
    const result = await resolveTextRequest({
        text: "Выставь счёт ООО ГИПЕР на Товар, 1 штука, 100 рублей, НДС 22%",
        productRef,
    }, { catalog, productResolver });
    assert.equal(result.productRef, productRef);
    assert.deepEqual(calls.map(call => call[0]), ["client", "product", "contract"]);
});

test("confirmation API contract остаётся покрыт отдельным confirmation suite", () => {
    const confirmation = require("../invoice-confirmation-service");
    assert.equal(typeof confirmation.preview, "function");
    assert.equal(typeof confirmation.confirm, "function");
});
