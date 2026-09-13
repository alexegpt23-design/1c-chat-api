const { AppError } = require("./errors");
const catalogDefault = require("./catalog-service");
const {
    buildCounterpartyIndex,
    searchCounterparties,
    verifyCounterparty,
} = require("./counterparty-search-service");

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function publicCandidate(item) {
    return { ref: item.ref, name: item.name };
}

function createCounterpartyResolver(options = {}) {
    const catalog = options.catalog || catalogDefault;
    const buildIndex = options.buildIndex || (() => buildCounterpartyIndex());
    const search = options.search || searchCounterparties;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const now = options.now || Date.now;
    const log = options.log || console;
    const mode = options.mode || process.env.COUNTERPARTY_SEARCH_MODE || "normalized";
    let cache = null;
    let refreshPromise = null;

    async function refreshIndex() {
        if (!refreshPromise) {
            refreshPromise = Promise.resolve().then(buildIndex).then(index => {
                if (!index || !Array.isArray(index.counterparties)) {
                    throw new Error("Некорректный индекс контрагентов");
                }
                cache = { index, expiresAt: now() + ttlMs };
                return index;
            }).finally(() => {
                refreshPromise = null;
            });
        }
        return refreshPromise;
    }

    async function currentIndex() {
        if (cache && cache.expiresAt > now()) return cache.index;
        try {
            return await refreshIndex();
        } catch (error) {
            if (cache) {
                log.warn("[Поиск клиента] refreshFailed=true, staleIndex=true");
                return cache.index;
            }
            throw error;
        }
    }

    async function legacy(query, startedAt) {
        const candidates = await catalog.findClient(query);
        log.log(`[Поиск клиента] clientSearchMode=odata-fallback, durationMs=${now() - startedAt}, decision=legacy, candidateCount=${candidates.length}`);
        return { mode: "odata-fallback", candidates };
    }

    async function resolveByText(query, fallbackQuery = query) {
        const startedAt = now();
        if (mode != "normalized") return legacy(fallbackQuery, startedAt);
        let result;
        try {
            const index = await currentIndex();
            result = search(query, index);
        } catch (error) {
            log.warn(`[Поиск клиента] clientSearchMode=normalized, durationMs=${now() - startedAt}, decision=unavailable, candidateCount=0`);
            return legacy(fallbackQuery, startedAt);
        }

        const candidates = (result.candidates || []).slice(0, 5).map(publicCandidate);
        log.log(`[Поиск клиента] clientSearchMode=normalized, durationMs=${now() - startedAt}, decision=${result.decision}, candidateCount=${candidates.length}`);

        if (result.decision === "ambiguous") {
            throw new AppError("Найдено несколько вариантов: клиент. Укажите clientRef", 409, {
                field: "clientRef",
                candidates,
            });
        }
        if (result.decision === "not_found" || !result.candidate) {
            return legacy(fallbackQuery, startedAt);
        }

        try {
            const row = await verifyCounterparty(result.candidate.ref, catalog);
            if (row.DeletionMark === true || row.IsFolder === true) {
                cache = null;
                return legacy(fallbackQuery, startedAt);
            }
            return { mode: "normalized", candidates: [catalog.summary("client", row)] };
        } catch (error) {
            if (error instanceof AppError && error.status === 404) {
                cache = null;
                return legacy(fallbackQuery, startedAt);
            }
            throw error;
        }
    }

    return {
        resolveByText,
        refreshIndex,
        getCacheInfo: () => cache && ({
            count: cache.index.counterparties.length,
            expiresAt: cache.expiresAt,
        }),
    };
}

let singleton;
function getCounterpartyResolver() {
    return singleton ||= createCounterpartyResolver();
}

module.exports = {
    DEFAULT_TTL_MS,
    createCounterpartyResolver,
    getCounterpartyResolver,
};
