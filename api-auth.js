const { createHash, timingSafeEqual } = require("node:crypto");
const { validPdfAccess } = require("./pdf-access");

function equalSecret(value, expected) {
    if (typeof value !== "string" || typeof expected !== "string" || !expected) return false;
    const digest = text => createHash("sha256").update(text).digest();
    return timingSafeEqual(digest(value), digest(expected));
}

function validApiKey(value) {
    return equalSecret(value, process.env.API_KEY)
        || equalSecret(value, process.env.CHATGPT_API_KEY);
}

function requireApiKey(req, res, next) {
    if (validApiKey(req.get("X-API-Key")) || (process.env.API_KEY && validPdfAccess(req))) return next();
    res.status(401).json({ error: "Unauthorized" });
}

module.exports = { requireApiKey, validApiKey };
