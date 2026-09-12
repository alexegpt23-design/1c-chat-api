const { createHmac, timingSafeEqual } = require("node:crypto");
const { guid } = require("./catalog-service");

const PDF_TTL_SECONDS = 15 * 60;
function signature(ref, expires) {
    const secret = process.env.PDF_SIGNING_KEY || process.env.API_KEY;
    if (!secret) throw new Error("Нужен API_KEY или PDF_SIGNING_KEY для подписания PDF");
    return createHmac("sha256", secret).update(`invoice-pdf:${guid(ref)}:${expires}`).digest("hex");
}
function signPdfUrl(url, ref, now = Date.now()) {
    const expires = String(Math.floor(now / 1000) + PDF_TTL_SECONDS);
    const result = new URL(url);
    result.searchParams.set("expires", expires);
    result.searchParams.set("token", signature(ref, expires));
    return result.href;
}
function validPdfAccess(req, now = Date.now()) {
    if (!["GET", "HEAD"].includes(req.method)) return false;
    const match = req.path.match(/^\/invoice\/([\da-f-]{36})\/pdf$/i);
    const { expires, token } = req.query;
    if (!match || typeof expires !== "string" || !/^\d{10}$/.test(expires) ||
        typeof token !== "string" || !/^[\da-f]{64}$/.test(token)) return false;
    const remaining = Number(expires) - Math.floor(now / 1000);
    if (remaining <= 0 || remaining > PDF_TTL_SECONDS) return false;
    try { return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(signature(match[1], expires), "hex")); }
    catch { return false; }
}
module.exports = { signPdfUrl, validPdfAccess, PDF_TTL_SECONDS };
