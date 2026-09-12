const { test } = require("node:test");
const assert = require("node:assert/strict");
process.env.ONEC_URL = "http://onec.invalid/odata/standard.odata/";
process.env.ONEC_USER = "test-user";
process.env.ONEC_PASSWORD = "test-password";
const { AppError } = require("../errors");
const { createConfirmationService, TTL_MS } = require("../invoice-confirmation-service");

const created = { number: "AUTO-001", date: "2026-09-12T17:00:00", amount: 12200, posted: true, Ref_Key: "00000000-0000-0000-0000-000000000001" };
function fixture(options = {}) {
    let time = 0;
    const writes = [];
    const source = { preview: { created: false, client: { ref: "client-1" }, price: 12200, total: 12200 }, payload: { Posted: false, Date: created.date, СуммаДокумента: 12200, Товары: [{ Цена: 12200 }] } };
    const service = createConfirmationService({
        prepare: async () => source,
        create: async payload => { writes.push(payload); return created; },
        now: () => time,
        ...options,
    });
    return { service, writes, source, advance: value => { time = value; } };
}

test("подтверждения уникальны, живут 10 минут, preview не вызывает запись", async () => {
    const { service, writes } = fixture();
    const first = await service.preview({ text: "текст" });
    const second = await service.preview({ text: "текст" });
    assert.notEqual(first.confirmationId, second.confirmationId);
    assert.equal(Date.parse(first.expiresAt), 600000);
    assert.equal(TTL_MS, 600000);
    assert.equal(first.created, false);
    assert.equal(writes.length, 0);
});

test("подтверждение пишет исходный снимок и повторно возвращает прежний результат", async () => {
    const { service, writes, source } = fixture();
    const preview = await service.preview({});
    preview.price = 1;
    source.payload.Товары[0].Цена = 1;
    source.payload.СуммаДокумента = 1;
    const first = await service.confirm({ confirmationId: preview.confirmationId });
    assert.equal(first.reused, false);
    assert.equal(first.result.Number, "AUTO-001");
    first.result.Number = "modified";
    const second = await service.confirm({ confirmationId: preview.confirmationId });
    assert.equal(second.reused, true);
    assert.equal(second.result.Number, "AUTO-001");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].Товары[0].Цена, 12200);
    assert.equal(writes[0].СуммаДокумента, 12200);
    assert.equal(writes[0].Posted, false);
    assert.equal(Object.hasOwn(writes[0], "Number"), false);
});

test("истёкшее и неизвестное подтверждение не создают документ", async () => {
    const { service, writes, advance } = fixture();
    const preview = await service.preview({});
    advance(TTL_MS);
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 410 });
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 404 });
    await assert.rejects(service.confirm({ confirmationId: created.Ref_Key }), { status: 404 });
    assert.equal(writes.length, 0);
});

test("очистка удаляет истёкшие записи, новый экземпляр сервера не знает старые ID", async () => {
    const { service, advance, writes } = fixture();
    const preview = await service.preview({});
    await assert.rejects(fixture().service.confirm({ confirmationId: preview.confirmationId }), { status: 404 });
    advance(TTL_MS);
    service.cleanup();
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 404 });
    assert.equal(writes.length, 0);
});

test("одновременное подтверждение и истечение TTL во время записи не создают дубль", async () => {
    let release;
    let count = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const { service, advance } = fixture({ create: async () => { count++; await gate; return created; } });
    const preview = await service.preview({});
    advance(TTL_MS - 1);
    const first = service.confirm({ confirmationId: preview.confirmationId });
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 409 });
    advance(TTL_MS + 1);
    service.cleanup();
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 409 });
    release();
    assert.equal((await first).result.Posted, true);
    assert.equal(count, 1);
    await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 410 });
});

test("ошибка проведения и тайм-аут блокируют повторную запись тем же ID", async () => {
    for (const details of [{ stage: "post", created: true, Ref_Key: created.Ref_Key }, { stage: "create", created: "unknown" }]) {
        let count = 0;
        const { service } = fixture({ create: async () => { count++; throw new AppError("Ошибка 1С", 502, details); } });
        const preview = await service.preview({});
        await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), { status: 502 });
        await assert.rejects(service.confirm({ confirmationId: preview.confirmationId }), error => {
            assert.equal(error.status, 409);
            assert.equal(error.details.retrySafe, false);
            assert.equal(error.details.created, details.created);
            assert.equal(error.details.Ref_Key, details.Ref_Key);
            return true;
        });
        assert.equal(count, 1);
    }
});

test("нельзя подменить цену или номер в запросе подтверждения", async () => {
    const { service, writes } = fixture();
    const { confirmationId } = await service.preview({});
    for (const body of [null, [], {}, { confirmationId: "bad" }, { confirmationId, price: 1 }, { confirmationId, Number: "123" }]) {
        await assert.rejects(service.confirm(body), { status: 400 });
    }
    assert.equal(writes.length, 0);
});
