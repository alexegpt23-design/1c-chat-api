const { createHash, timingSafeEqual } = require("node:crypto");
const { validPdfAccess } = require("./pdf-access");

function validApiKey(value) {
    const expected = process.env.API_KEY;
    if (!expected || typeof value !== "string") return false;
    const digest = text => createHash("sha256").update(text).digest();
    return timingSafeEqual(digest(value), digest(expected));
}

function requireApiKey(req, res, next) {
    if (validApiKey(req.get("X-API-Key")) || (process.env.API_KEY && validPdfAccess(req))) return next();
    res.status(401).json({ error: "Unauthorized" });
}

module.exports = { requireApiKey, validApiKey };
