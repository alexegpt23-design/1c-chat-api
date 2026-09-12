const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const dotenv = require("dotenv");
const envFile = path.join(__dirname, "..", ".env");
const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
const settings = dotenv.parse(existing);
if (settings.API_KEY?.trim() && settings.API_KEY !== "replace-with-random-secret") {
    console.log("API_KEY уже настроен; существующее значение сохранено.");
} else {
    const cleaned = existing.replace(/^\s*(?:export\s+)?API_KEY\s*=.*(?:\r?\n|$)/gm, "");
    fs.writeFileSync(envFile, cleaned.trimEnd() + `\nAPI_KEY=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    console.log("Случайный API_KEY сохранён в .env. Значение не выводится в лог.");
}
