const assert = require("node:assert/strict");
const invoice = require("../examples/invoice.json");
const baseURL = process.env.API_URL || "http://127.0.0.1:3001";

async function request(path, body) {
    const response = await fetch(baseURL + path, {
        method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(120000),
    });
    const data = await response.json();
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(data)}`);
    console.log(`${path}: HTTP ${response.status}`, JSON.stringify(data));
    return data;
}
async function main() {
    assert.equal((await request("/ping")).ok, true);
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
    console.log("Проверки пройдены. Документы не создавались.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
