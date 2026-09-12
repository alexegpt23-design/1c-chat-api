const express = require("express");
const { randomUUID } = require("node:crypto");
const { oneC, redact } = require("./onec-client");
const { AppError } = require("./errors");
const invoiceService = require("./invoice-service");
const invoiceTextService = require("./invoice-text-service");
const invoiceConfirmationService = require("./invoice-confirmation-service");
const app = express();

app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader("X-Request-Id", req.requestId);
    const startedAt = Date.now();
    console.log(`[HTTP ${req.requestId}] -> ${req.method} ${req.path}`);
    res.on("finish", () => console.log(`[HTTP ${req.requestId}] <- ${res.statusCode} (${Date.now() - startedAt} мс)`));
    next();
});
app.use(express.json({ limit: "32kb" }));

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
    const port = Number(process.env.PORT || 3001);
    const host = process.env.HOST || "127.0.0.1";
    app.listen(port, host, () => console.log(`1C Chat API запущен: http://${host}:${port}`))
        .on("error", error => { console.error(`Не удалось запустить сервис: ${error.message}`); process.exitCode = 1; });
}
module.exports = app;
