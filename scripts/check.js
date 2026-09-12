const assert = require("node:assert/strict");
require("dotenv").config({ path: require("node:path").join(__dirname, "..", ".env"), quiet: true });
const invoice = require("../examples/invoice.json");
const baseURL = process.env.API_URL || "http://127.0.0.1:3001";

async function request(path, body) {
    const response = await fetch(baseURL + path, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", "X-API-Key": process.env.API_KEY },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    console.log(`${path}: HTTP ${response.status}`, JSON.stringify(data));
    return data;
}
async function main() {
    assert.ok(process.env.API_KEY, "Задайте API_KEY");
    assert.equal((await fetch(baseURL + "/ping", { signal: AbortSignal.timeout(30000) })).status, 401);
    const failures = [];
    async function check(label, work) {
        try { await work(); }
        catch (error) { failures.push(label); console.error(`${label}: ${error.message}`); }
    }
    await check("ping", async () => assert.equal((await request("/ping")).ok, true));
    await check("Справочники и предпросмотр", async () => {
        const clients = await request("/find-client", { name: invoice.clientName });
        assert.equal(clients.length, 1, "Ожидается один контрагент из examples/invoice.json");
        const products = await request("/find-product", { name: "Фискальный накопитель" });
        assert.ok(products.some(product => product.ref === invoice.productRef));
        const contracts = await request("/find-contract", { clientRef: clients[0].ref });
        assert.ok(contracts.some(contract => contract.ref === invoice.contractRef));
        const preview = await request("/preview-invoice", invoice);
        assert.equal(preview.created, false);
        assert.equal(preview.total, 12200);
        assert.equal(preview.vatAmount, 2200);
        const textPreview = await request("/invoice-preview-text", require("../examples/invoice-from-text.json"));
        assert.equal(textPreview.status, "preview");
        assert.equal(textPreview.created, false);
        assert.ok(textPreview.confirmationId);
        assert.equal(textPreview.total, 12200);
    });
    if (process.env.ONEC_CHECK_INVOICE_REF) {
        await check("PDF", async () => {
            const response = await fetch(baseURL + `/invoice/${process.env.ONEC_CHECK_INVOICE_REF}/pdf`, {
                headers: { "X-API-Key": process.env.API_KEY }, signal: AbortSignal.timeout(120000),
            });
            if (!response.ok) throw new Error(`PDF: HTTP ${response.status}: ${await response.text()}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            assert.equal(buffer.subarray(0, 5).toString(), "%PDF-");
            const fs = require("node:fs");
            const path = require("node:path");
            fs.mkdirSync(path.join(__dirname, "..", "tmp"), { recursive: true });
            fs.writeFileSync(path.join(__dirname, "..", "tmp", "checked-invoice.pdf"), buffer);
            console.log(`PDF существующего счёта: HTTP 200, ${buffer.length} байт`);
        });
    }
    if (failures.length) throw new Error(`Не пройдены проверки: ${failures.join(", ")}. Документы не создавались.`);
    console.log("Проверки пройдены. Документы не создавались.");
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
