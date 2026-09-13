const DEFAULT_URL = "http://127.0.0.1:3199";
const VALID_DECISIONS = new Set(["selected", "ambiguous", "not_found"]);

class ProductSearchWorkerError extends Error {
    constructor(message, code, cause) {
        super(message);
        this.name = "ProductSearchWorkerError";
        this.code = code;
        this.cause = cause;
    }
}

function validateResult(value) {
    if (!value || typeof value !== "object" || !VALID_DECISIONS.has(value.decision)
        || !Array.isArray(value.candidates)
        || !("candidate" in value)) {
        throw new ProductSearchWorkerError("Worker вернул некорректный ответ", "MALFORMED_RESPONSE");
    }
    return value;
}

function createProductSearchClient(options = {}) {
    const baseUrl = options.baseUrl || process.env.PRODUCT_SEARCH_WORKER_URL || DEFAULT_URL;
    const timeoutMs = Number(options.timeoutMs || process.env.PRODUCT_SEARCH_WORKER_TIMEOUT_MS || 30000);
    const fetchImpl = options.fetch || fetch;

    return {
        async search(query) {
            let response;
            try {
                response = await fetchImpl(`${baseUrl}/search`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ query }),
                    signal: AbortSignal.timeout(timeoutMs),
                });
            } catch (error) {
                const timeout = error?.name === "TimeoutError" || error?.name === "AbortError";
                throw new ProductSearchWorkerError(
                    timeout ? "Истекло время ожидания semantic worker" : "Semantic worker недоступен",
                    timeout ? "TIMEOUT" : "UNAVAILABLE",
                    error,
                );
            }
            if (!response.ok) {
                throw new ProductSearchWorkerError(`Semantic worker вернул HTTP ${response.status}`, "HTTP_ERROR");
            }
            let result;
            try {
                result = await response.json();
            } catch (error) {
                throw new ProductSearchWorkerError("Worker вернул некорректный JSON", "MALFORMED_RESPONSE", error);
            }
            return validateResult(result);
        },
        async searchWithFallback(query, lexicalSearch) {
            try {
                return await this.search(query);
            } catch (error) {
                if (typeof lexicalSearch !== "function") throw error;
                return {
                    ...await lexicalSearch(query),
                    embeddingStatus: "unavailable",
                    embeddingError: error.code || "UNAVAILABLE",
                };
            }
        },
    };
}

module.exports = { DEFAULT_URL, ProductSearchWorkerError, validateResult, createProductSearchClient };
