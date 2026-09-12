// Поднимает текущий код на свободном локальном порту; выполняет только чтение 1С.
const app = require("../server");
async function main() {
    const server = app.listen(0, "127.0.0.1");
    await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
    process.env.API_URL = `http://127.0.0.1:${server.address().port}`;
    try { await require("./check").main(); }
    finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
