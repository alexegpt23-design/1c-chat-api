const LEGAL_FORM_OOO = "LEGAL_FORM_OOO";
const LEGAL_FORM_IP = "LEGAL_FORM_IP";

function baseNormalize(value) {
    return String(value || "")
        .normalize("NFKC")
        .toLowerCase()
        .replace(/ё/gu, "е")
        .replace(/(?<![а-яa-z0-9])о\s*\.\s*о\s*\.\s*о\.?(?![а-яa-z0-9])/gu, "ооо")
        .replace(/(?<![а-яa-z0-9])и\s*\.\s*п\.?(?![а-яa-z0-9])/gu, "ип")
        .replace(/[«»„“”‟"'`´]/gu, " ")
        .replace(/[.,;:()[\]{}\\/|_+=!?№]/gu, " ")
        .replace(/[‐‑‒–—−-]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
}

function extractLegalForms(value) {
    let text = baseNormalize(value);
    const forms = new Set();
    const patterns = [
        [LEGAL_FORM_OOO, /(?<![а-яa-z0-9])общество\s+(?:с\s+)?ограниченной\s+ответственностью(?![а-яa-z0-9])/giu],
        [LEGAL_FORM_OOO, /(?<![а-яa-z0-9])ооо(?![а-яa-z0-9])/giu],
        [LEGAL_FORM_IP, /(?<![а-яa-z0-9])индивидуальный\s+предприниматель(?![а-яa-z0-9])/giu],
        [LEGAL_FORM_IP, /(?<![а-яa-z0-9])ип(?![а-яa-z0-9])/giu],
    ];
    for (const [form, pattern] of patterns) {
        text = text.replace(pattern, () => {
            forms.add(form);
            return " ";
        });
    }
    return {
        legalForm: forms.size === 1 ? [...forms][0] : forms.size > 1 ? "LEGAL_FORM_CONFLICT" : null,
        legalForms: [...forms],
        coreName: text.replace(/\s+/gu, " ").trim(),
    };
}

function morphologyToken(token) {
    if (!/^[а-я]+$/u.test(token) || token.length < 4) return token;
    const surname = token.match(/^(.+(?:ов|ев|ин))(?:а|у|ым|ом|ой|е)?$/u);
    if (surname && surname[1].length >= 5) return surname[1];
    const rules = [
        [/(?:иями|иям|иях|ией|ию|ия|ий)$/u, ""],
        [/(?:ыми|ими|ого|его|ому|ему|ую|юю|ая|яя|ое|ее|ые|ие|ых|их|ым|им)$/u, ""],
        [/(?:ами|ями|ах|ях|ам|ям)$/u, ""],
        [/(?:ов|ев|ей)$/u, ""],
        [/(?:а|у|ы|и)$/u, ""],
    ];
    for (const [ending, replacement] of rules) {
        if (ending.test(token)) {
            const stem = token.replace(ending, replacement);
            if (stem.length >= 4) return stem;
        }
    }
    return token;
}

function normalizeCounterparty(value) {
    const normalizedName = baseNormalize(value);
    const legal = extractLegalForms(normalizedName);
    const tokens = [...new Set(legal.coreName.split(/\s+/u).filter(Boolean))];
    const morphologyTokens = [...new Set(tokens.map(morphologyToken))];
    const inn = normalizedName.match(/(?<!\d)(\d{10}|\d{12})(?!\d)/u)?.[1] || null;
    return {
        legalForm: legal.legalForm,
        legalForms: legal.legalForms,
        coreName: legal.coreName,
        normalizedName,
        tokens,
        morphologyTokens,
        inn,
    };
}

module.exports = {
    LEGAL_FORM_OOO,
    LEGAL_FORM_IP,
    baseNormalize,
    extractLegalForms,
    morphologyToken,
    normalizeCounterparty,
};
