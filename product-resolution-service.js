const { createHash } = require("node:crypto");
const { AppError } = require("./errors");
const catalogDefault = require("./catalog-service");
const { createProductSearchClient } = require("./product-search-client");
const { searchProductIndex } = require("./product-search-service");

function queryLabel(query) {
    return `length=${query.length}, sha256=${createHash("sha256").update(query).digest("hex")}`;
}

function createProductResolver(options = {}) {
    const catalog = options.catalog || catalogDefault;
    const workerClient = options.workerClient || createProductSearchClient({
        timeoutMs: options.timeoutMs || 2000,
    });
    const lexicalSearch = options.lexicalSearch || searchProductIndex;
    const mode = options.mode || process.env.PRODUCT_SEARCH_MODE || "odata";
    const log = options.log || console;

    async function verifyCandidate(candidate) {
        try {
            const row = await catalog.resolve("product", candidate.ref);
            if (row.DeletionMark === true || row.IsFolder === true) return null;
            return catalog.summary("product", row);
        } catch (error) {
            if (error instanceof AppError && error.status === 404) return null;
            throw error;
        }
    }

    async function verifyResult(result, searchMode, startedAt) {
        const source = result.decision === "selected"
            ? [result.candidate].filter(Boolean)
            : result.candidates || [];
        const verified = (await Promise.all(source.slice(0, 5).map(verifyCandidate))).filter(Boolean);
        log.log(`[Поиск товара] mode=${searchMode}, ${queryLabel(result.query)}, durationMs=${Date.now() - startedAt}, decision=${result.decision}, candidates=${verified.length}`);
        if (result.decision === "not_found" || !verified.length) {
            throw new AppError("Товар не найден", 404, { field: "productRef", candidates: [] });
        }
        if (result.decision === "ambiguous") {
            throw new AppError("Найдено несколько вариантов: товар. Укажите productRef", 409, {
                field: "productRef",
                candidates: verified,
            });
        }
        return { mode: searchMode, candidates: verified };
    }

    async function legacyOdataSearch(query) {
        let candidates = await catalog.findProduct(query);
        const shortProduct = query.match(/^ФН\s+(?:на\s+)?(\d+)\s+месяц(?:ев|а)?$/iu);
        if (!candidates.length && shortProduct) {
            candidates = await catalog.findProduct(`Фискальный накопитель на ${shortProduct[1]} месяцев`);
        }
        return candidates;
    }

    async function resolveByText(query) {
        if (mode !== "hybrid") {
            return { mode: "odata", candidates: await legacyOdataSearch(query) };
        }
        const startedAt = Date.now();
        let result;
        try {
            result = await workerClient.search(query);
            result.query = query;
            return await verifyResult(result, "hybrid", startedAt);
        } catch (error) {
            if (error instanceof AppError) throw error;
            log.warn(`[Поиск товара] workerFailure=${error.code || "UNKNOWN"}, ${queryLabel(query)}`);
        }
        try {
            result = lexicalSearch(query, {
                autoThreshold: 135,
                marginThreshold: 30,
            });
            result.query = query;
            return await verifyResult(result, "lexical-fallback", startedAt);
        } catch (error) {
            if (error instanceof AppError) throw error;
            log.warn(`[Поиск товара] localIndexFailure=${error.code || error.name || "UNKNOWN"}, ${queryLabel(query)}`);
        }
        const candidates = await legacyOdataSearch(query);
        log.log(`[Поиск товара] mode=odata-fallback, ${queryLabel(query)}, durationMs=${Date.now() - startedAt}, decision=legacy, candidates=${candidates.length}`);
        return { mode: "odata-fallback", candidates };
    }

    return { resolveByText };
}

let singleton;
function getProductResolver() {
    return singleton ||= createProductResolver();
}

module.exports = { queryLabel, createProductResolver, getProductResolver };
