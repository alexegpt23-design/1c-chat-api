// Только чтение. Не отправляет реквизиты 1С или API-ключ на внешний адрес.
async function main() {
    for (const path of ["/ping", "/openapi.json"]) {
        try {
            const response = await fetch("https://api.scheta.online" + path, { signal: AbortSignal.timeout(20000), redirect: "error" });
            console.log(`${path}: HTTP ${response.status}; ${response.headers.get("content-type")}`);
        } catch (error) {
            console.log(`${path}: ${error.cause?.code || error.name}`);
            process.exitCode = 1;
        }
    }
}
main();
