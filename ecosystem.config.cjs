module.exports = {
    apps: [
        {
            name: "1c-chat-api",
            script: "server.js",
            cwd: __dirname,
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            max_memory_restart: "512M",
            env: { NODE_ENV: "production" },
            time: true,
        },
        {
            name: "1c-product-search-worker",
            script: "product-search-worker.js",
            cwd: __dirname,
            instances: 1,
            exec_mode: "fork",
            autorestart: true,
            restart_delay: 5000,
            max_memory_restart: "700M",
            env: {
                NODE_ENV: "production",
                PRODUCT_SEARCH_WORKER_HOST: "127.0.0.1",
                PRODUCT_SEARCH_WORKER_PORT: "3199",
                PRODUCT_EMBEDDING_LOCAL_ONLY: "true",
            },
            time: true,
        },
    ],
};
