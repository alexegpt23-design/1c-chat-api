const express = require("express");
const { randomUUID } = require("node:crypto");
const { oneC, redact } = require("./onec-client");
const { AppError } = require("./errors");
const invoiceService = require("./invoice-service");
const invoiceTextService = require("./invoice-text-service");
const invoiceConfirmationService = require("./invoice-confirmation-service");
const invoicePdfService = require("./invoice-pdf-service");
const { requireApiKey } = require("./api-auth");
const app = express();

app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const startedAt = Date.now();
    console.log(`[HTTP ${req.requestId}] -> ${req.method} ${req.path}`);
    res.on("finish", () => console.log(`[HTTP ${req.requestId}] <- ${res.statusCode} (${Date.now() - startedAt} мс)`));
    next();
});
app.disable("x-powered-by");
app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
});
app.use(requireApiKey);
app.use(express.json({ limit: "32kb" }));
app.get("/openapi.json", (req, res) => res.json(require("./openapi.json")));
app.get("/invoice/:id/pdf", async (req, res) => {
    const { buffer, filename } = await invoicePdfService.generatePdf(req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="invoice.pdf"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.type("application/pdf").send(buffer);
});

// Сохраняем адрес, статус и формат ответа существующего /ping.
app.get("/ping", async (req, res) => {
    try {
        await oneC.get("/");
        res.json({ ok: true, message: "1С доступна" });
    } catch (error) {
        res.status(500).json({ ok: false, error: error.message });
    }
});
app.post("/find-client", async (req, res) => res.json(await invoiceService.findClient(req.body?.name)));
app.post("/find-product", async (req, res) => res.json(await invoiceService.findProduct(req.body?.name)));
app.post("/find-contract", async (req, res) => res.json(await invoiceService.findContracts(req.body?.clientRef, req.body?.name)));
app.post("/preview-invoice", async (req, res) => res.json(await invoiceService.previewInvoice(req.body)));
app.post("/create-invoice", async (req, res) => {
    const result = await invoiceService.createInvoice(req.body);
    res.status(result.dryRun ? 200 : 201).json(result);
});
app.post("/test-create-invoice", async (req, res) => {
    const result = await invoiceService.testCreateInvoice(req.body);
    res.status(result.dryRun ? 200 : 201).json(result);
});
app.post("/invoice-preview-from-text", async (req, res) => res.json(await invoiceTextService.previewFromText(req.body)));
app.post("/invoice-create-from-text", async (req, res) => {
    const result = await invoiceTextService.createFromText(req.body);
    res.status(result.dryRun ? 200 : 201).json(result);
});
app.post("/invoice-confirmation-preview", async (req, res) => res.json(await invoiceConfirmationService.preview(req.body)));
app.post("/invoice-preview-text", async (req, res) => {
    const preview = await invoiceConfirmationService.preview(req.body);
    res.json({ ...preview, client: preview.client.name, product: preview.product.name, contract: preview.contract.name,
        clientRef: preview.client.ref, productRef: preview.product.ref, contractRef: preview.contract.ref, vat: preview.vatRate });
});
app.post("/invoice-confirm", async (req, res) => {
    const { result, reused } = await invoiceConfirmationService.confirm(req.body);
    res.status(reused ? 200 : 201).json(result);
});
app.use((req, res) => res.status(404).json({ error: "Маршрут не найден" }));
app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === "entity.parse.failed" ? 400 : error.type === "entity.too.large" ? 413 : error instanceof AppError ? error.status : 500;
    const message = error.type === "entity.parse.failed" ? "Некорректный JSON" : status === 500 ? "Внутренняя ошибка сервиса" : error.message;
    console.error(`[HTTP ${req.requestId}] Ошибка: ${redact(message)}`);
    res.status(status).json({ error: redact(message), ...(error.details ? { details: error.details } : {}), requestId: req.requestId });
});

if (require.main === module) {
    if (!process.env.API_KEY?.trim()) throw new Error("В .env не задан API_KEY; запуск API без защиты запрещён");
    invoicePdfService.pdfUrl("00000000-0000-0000-0000-000000000001");
    const port = Number(process.env.PORT || 3001);
    const host = process.env.HOST || "127.0.0.1";
    app.listen(port, host, () => console.log(`1C Chat API запущен: http://${host}:${port}`))
        .on("error", error => { console.error(`Не удалось запустить сервис: ${error.message}`); process.exitCode = 1; });
}
module.exports = app;
