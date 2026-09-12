module.exports = {
    apps: [{
        name: "1c-chat-api",
        script: "server.js",
        cwd: __dirname,
        instances: 1,
        exec_mode: "fork",
        autorestart: true,
        max_memory_restart: "512M",
        env: { NODE_ENV: "production" },
        time: true,
    }],
};
