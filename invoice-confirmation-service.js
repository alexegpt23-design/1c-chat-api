const { randomUUID } = require("node:crypto");
const { AppError } = require("./errors");
const invoiceService = require("./invoice-service");
const { resolveTextRequest } = require("./invoice-text-service");

const TTL_MS = 10 * 60 * 1000;

function createConfirmationService({
    prepare = async body => invoiceService.prepareInvoice(await resolveTextRequest(body)),
    create = payload => invoiceService.createPreparedInvoice(payload),
    now = () => Date.now(),
} = {}) {
    const confirmations = new Map();

    function cleanup() {
        for (const [id, entry] of confirmations) {
            // Уже начатая запись должна закончиться даже после истечения TTL.
            if (entry.status !== "processing" && now() >= entry.expiresAt) confirmations.delete(id);
        }
    }

    async function preview(body) {
        const { preview, payload } = await prepare(body);
        cleanup();
        const confirmationId = randomUUID();
        const expiresAt = now() + TTL_MS;
        // Изолируем снимок от входного объекта, возвращаемого preview и изменений настроек.
        confirmations.set(confirmationId, { payload: structuredClone(payload), expiresAt, status: "pending" });
        console.log(`[Подтверждение] Предпросмотр готов; действует до ${new Date(expiresAt).toISOString()}`);
        return { ...structuredClone(preview), confirmationId, expiresAt: new Date(expiresAt).toISOString() };
    }

    async function confirm(body) {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "confirmationId") ||
            typeof body.confirmationId !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(body.confirmationId)) {
            throw new AppError("Ожидается только confirmationId из предпросмотра", 400);
        }
        const id = body.confirmationId.toLowerCase();
        const entry = confirmations.get(id);
        if (!entry) throw new AppError("Подтверждение не найдено или уже удалено по сроку действия", 404);
        if (entry.status === "processing") throw new AppError("Создание по этому подтверждению уже выполняется", 409);
        if (now() >= entry.expiresAt) {
            confirmations.delete(id);
            throw new AppError("Срок подтверждения истёк; запросите новый предпросмотр", 410);
        }
        if (entry.status === "completed") return { result: structuredClone(entry.result), reused: true };
        if (entry.status === "failed") throw new AppError("Предыдущая попытка завершилась ошибкой. Проверьте результат в 1С перед новым предпросмотром", 409, {
            ...entry.errorDetails, retrySafe: false,
        });

        // До первого await: второй запрос не может начать создание с тем же ID.
        entry.status = "processing";
        console.log("[Подтверждение] Получено подтверждение; создаём сохранённый счёт");
        try {
            const created = await create(structuredClone(entry.payload));
            entry.result = { Number: created.number, Date: created.date, Сумма: created.amount, Posted: created.posted, Ref_Key: created.Ref_Key };
            entry.status = "completed";
            delete entry.payload;
            return { result: structuredClone(entry.result), reused: false };
        } catch (error) {
            // Даже тайм-аут не делает ID доступным повторно: документ мог сохраниться.
            entry.status = "failed";
            entry.errorDetails = { ...error.details, retrySafe: false };
            delete entry.payload;
            throw error;
        }
    }

    return { preview, confirm, cleanup };
}

const confirmationService = createConfirmationService();
setInterval(() => confirmationService.cleanup(), 60000).unref();
module.exports = { ...confirmationService, createConfirmationService, TTL_MS };
