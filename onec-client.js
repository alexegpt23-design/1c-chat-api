const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });
const axios = require("axios");
const { AppError } = require("./errors");

for (const key of ["ONEC_URL", "ONEC_USER", "ONEC_PASSWORD"]) {
    if (!process.env[key]) throw new Error(`В .env не задан ${key}`);
}
const base = new URL(process.env.ONEC_URL);
if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("ONEC_URL должен быть HTTP(S)-адресом OData без авторизации и параметров");
}

// Не выводим конфигурацию axios: она содержит пароль и заголовок Authorization.
function redact(value) {
    let result = String(value);
    for (const secret of [process.env.ONEC_PASSWORD, process.env.ONEC_USER, process.env.ONEC_URL, process.env.API_KEY, process.env.PDF_SIGNING_KEY]) {
        if (secret) result = result.split(secret).join("[скрыто]");
    }
    return result;
}

const oneC = axios.create({
    baseURL: base.href.replace(/\/+$/, "") + "/",
    auth: { username: process.env.ONEC_USER, password: process.env.ONEC_PASSWORD },
    timeout: Number(process.env.ONEC_TIMEOUT_MS) || 30000,
    maxRedirects: 0,
    // Для этой локальной интеграции используется прямое соединение с 1С.
    // ONEC_USE_PROXY=true включает стандартные HTTP(S)_PROXY переменные axios.
    proxy: process.env.ONEC_USE_PROXY === "true" ? undefined : false,
    // 1С требует %20 для пробелов; стандартная сериализация axios использует +.
    paramsSerializer: { serialize: params => Object.entries(params)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join("&") },
    headers: { Accept: "application/json", "Content-Type": "application/json" },
});

oneC.interceptors.request.use(config => {
    config.startedAt = Date.now();
    console.log(`[1C] -> ${config.method.toUpperCase()} ${config.url}`, redact(JSON.stringify(config.params || {})));
    return config;
});
oneC.interceptors.response.use(response => {
    console.log(`[1C] <- ${response.status} ${response.config.url} (${Date.now() - response.config.startedAt} мс)`);
    return response;
}, error => {
    const data = error.response?.data;
    const odata = data?.["odata.error"] || data?.error;
    const message = typeof odata?.message === "string" ? odata.message : odata?.message?.value;
    const timeout = ["ECONNABORTED", "ETIMEDOUT"].includes(error.code);
    const safeMessage = redact(message || (error.response ? `1С вернула HTTP ${error.response.status}` : timeout ? "Истекло время ожидания ответа 1С" : `Ошибка соединения с 1С (${error.code || "NETWORK_ERROR"})`));
    console.error(`[1C] ОШИБКА ${error.config?.method?.toUpperCase()} ${error.config?.url}: ${safeMessage}`);
    return Promise.reject(new AppError(safeMessage, timeout ? 504 : 502, {
        upstreamStatus: error.response?.status,
        odataCode: odata?.code === undefined ? undefined : redact(odata.code),
    }));
});

module.exports = { oneC, redact };
