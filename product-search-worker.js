const express = require("express");
const http = require("node:http");
const { loadEmbeddingBundle } = require("./product-embedding-index");
const { getEmbeddingService } = require("./product-embedding-service");
const { searchProductIndexHybrid } = require("./product-search-service");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3199;
const MAX_QUERY_LENGTH = 500;

function createProductSearchWorker(options = {}) {
    const app = express();
    const loadBundle = options.loadBundle || loadEmbeddingBundle;
    let bundle = options.bundle || loadBundle(options);
    const embeddingService = options.embeddingService || getEmbeddingService();
    const fs = require("node:fs");
    const reloadEnabled = options.reloadIndex ?? !options.bundle;
    let metadataMtimeMs = reloadEnabled ? fs.statSync(bundle.paths.metadataPath).mtimeMs : null;
    let reloadPromise;
    async function refreshBundle() {
        if (!reloadEnabled) return bundle;
        const currentMtimeMs = fs.statSync(bundle.paths.metadataPath).mtimeMs;
        if (currentMtimeMs === metadataMtimeMs) return bundle;
        reloadPromise ||= Promise.resolve().then(() => {
            const replacement = loadBundle(options);
            bundle = replacement;
            metadataMtimeMs = fs.statSync(bundle.paths.metadataPath).mtimeMs;
            console.log(`[product-search-worker] index reloaded: ${bundle.metadata.indexVersion}`);
            return bundle;
        }).catch(error => {
            console.error("[product-search-worker] index reload failed:", error.message);
            return bundle;
        }).finally(() => { reloadPromise = undefined; });
        return reloadPromise;
    }
    const search = options.search || ((query, currentBundle) => searchProductIndexHybrid(query, {
        bundle: currentBundle,
        embeddingService,
        requireEmbeddings: true,
    }));

    app.disable("x-powered-by");
    app.use(express.json({ limit: "2kb", strict: true }));

    app.get("/health", (_req, res) => {
        res.json({
            ok: true,
            modelLoaded: Boolean(embeddingService.isLoaded),
            indexItems: bundle.index.products.length,
            embeddingDimension: bundle.metadata.dimension,
        });
    });

    app.post("/search", async (req, res, next) => {
        try {
            const query = req.body?.query;
            if (typeof query !== "string" || !query.trim()) {
                return res.status(400).json({ error: "query должен быть непустой строкой" });
            }
            if (query.length > MAX_QUERY_LENGTH) {
                return res.status(400).json({ error: `query не должен превышать ${MAX_QUERY_LENGTH} символов` });
            }
            await refreshBundle();
            const result = await search(query.trim(), bundle);
            res.json(result);
        } catch (error) {
            next(error);
        }
    });

    app.use((error, _req, res, _next) => {
        if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
            return res.status(400).json({ error: "Некорректный JSON" });
        }
        console.error("[product-search-worker]", error?.message || "Ошибка поиска");
        res.status(503).json({ error: "Semantic search временно недоступен" });
    });

    return app;
}

function startProductSearchWorker(options = {}) {
    const host = options.host || process.env.PRODUCT_SEARCH_WORKER_HOST || DEFAULT_HOST;
    const port = Number(options.port ?? process.env.PRODUCT_SEARCH_WORKER_PORT ?? DEFAULT_PORT);
    const server = http.createServer(createProductSearchWorker(options));
    server.requestTimeout = Number(options.requestTimeout || 30000);
    server.headersTimeout = server.requestTimeout + 5000;

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve({
                server,
                host,
                port: server.address().port,
                close: () => new Promise((done, fail) => server.close(error => error ? fail(error) : done())),
            });
        });
    });
}

async function main() {
    const worker = await startProductSearchWorker();
    console.log(`[product-search-worker] listening on http://${worker.host}:${worker.port}`);
    let closing = false;
    const shutdown = async signal => {
        if (closing) return;
        closing = true;
        console.log(`[product-search-worker] ${signal}, shutting down`);
        try {
            await worker.close();
            process.exitCode = 0;
        } catch (error) {
            console.error("[product-search-worker]", error.message);
            process.exitCode = 1;
        }
    };
    process.once("SIGTERM", () => void shutdown("SIGTERM"));
    process.once("SIGINT", () => void shutdown("SIGINT"));
}

if (require.main === module) {
    main().catch(error => {
        console.error("[product-search-worker]", error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    DEFAULT_HOST,
    DEFAULT_PORT,
    MAX_QUERY_LENGTH,
    createProductSearchWorker,
    startProductSearchWorker,
};
