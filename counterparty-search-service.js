const { oneC } = require("./onec-client");
const { normalizeCounterparty, baseNormalize } = require("./counterparty-search-normalizer");

const COUNTERPARTY_FIELDS = [
    "Ref_Key", "DataVersion", "Code", "Description", "НаименованиеПолное", "ИНН",
];

function buildCounterpartyDocument(row) {
    const nameAnalysis = normalizeCounterparty(row.Description);
    const fullAnalysis = normalizeCounterparty(row.НаименованиеПолное);
    const legalForm = nameAnalysis.legalForm || fullAnalysis.legalForm;
    const tokens = [...new Set([...nameAnalysis.tokens, ...fullAnalysis.tokens])];
    const morphologyTokens = [...new Set([...nameAnalysis.morphologyTokens, ...fullAnalysis.morphologyTokens])];
    return {
        ref: row.Ref_Key,
        dataVersion: row.DataVersion,
        code: row.Code || "",
        name: row.Description || "",
        fullName: row.НаименованиеПолное || "",
        inn: row.ИНН || "",
        legalForm,
        coreName: nameAnalysis.coreName || fullAnalysis.coreName,
        normalizedName: nameAnalysis.normalizedName,
        normalizedFullName: fullAnalysis.normalizedName,
        tokens,
        morphologyTokens,
    };
}

async function fetchCounterparties(client = oneC) {
    const rows = [];
    const pageSize = 200;
    for (let skip = 0; skip < 10000;) {
        const { data } = await client.get("Catalog_Контрагенты", { params: {
            $format: "json",
            $select: COUNTERPARTY_FIELDS.join(","),
            $filter: "DeletionMark eq false and IsFolder eq false",
            $orderby: "Ref_Key",
            $top: pageSize,
            $skip: skip,
        } });
        const page = data?.value || data?.d?.results;
        if (!Array.isArray(page)) throw new Error("1С вернула некорректный список контрагентов");
        rows.push(...page);
        skip += page.length;
        if (page.length < pageSize && !data["odata.nextLink"] && !data?.d?.__next) break;
    }
    return rows;
}

function intersectionCount(left, right) {
    const values = new Set(right);
    return left.reduce((count, token) => count + (values.has(token) ? 1 : 0), 0);
}

function scoreCounterparty(queryText, item) {
    const query = normalizeCounterparty(queryText);
    const candidate = item.normalizedName ? item : buildCounterpartyDocument(item);
    let lexicalScore = 0;
    let morphologyScore = 0;
    const reasons = [];
    const legalConflict = Boolean(
        query.legalForm && candidate.legalForm && query.legalForm !== candidate.legalForm
    );

    if (query.normalizedName === candidate.normalizedName
        || query.normalizedName === candidate.normalizedFullName) {
        lexicalScore += 160;
        reasons.push("exact-normalized");
    }
    if (query.coreName && query.coreName === candidate.coreName) {
        lexicalScore += 180;
        reasons.push("exact-core");
    }
    const sortedQuery = [...query.tokens].sort().join(" ");
    const sortedCandidate = [...candidate.tokens].sort().join(" ");
    if (sortedQuery && sortedQuery === sortedCandidate) {
        lexicalScore += 100;
        reasons.push("word-order-independent");
    }
    const tokenCoverage = intersectionCount(query.tokens, candidate.tokens) / Math.max(query.tokens.length, 1);
    lexicalScore += tokenCoverage * 70;
    if (tokenCoverage) reasons.push("token-coverage:" + tokenCoverage.toFixed(2));

    if (query.coreName && (
        baseNormalize(candidate.fullName).includes(query.coreName)
        || candidate.coreName.includes(query.coreName)
    )) {
        lexicalScore += 35;
        reasons.push("full-or-core-phrase");
    }
    if (query.legalForm && query.legalForm === candidate.legalForm) {
        lexicalScore += 40;
        reasons.push("legal-form");
    }
    if (legalConflict) {
        lexicalScore -= 2000;
        reasons.push("legal-form-conflict");
    }

    const morphologyCoverage = intersectionCount(query.morphologyTokens, candidate.morphologyTokens)
        / Math.max(query.morphologyTokens.length, 1);
    morphologyScore += morphologyCoverage * 100;
    if (morphologyCoverage) reasons.push("morphology-coverage:" + morphologyCoverage.toFixed(2));
    if (query.morphologyTokens.length
        && [...query.morphologyTokens].sort().join(" ") === [...candidate.morphologyTokens].sort().join(" ")) {
        morphologyScore += 100;
        reasons.push("exact-morphology");
    }

    const compactQuery = baseNormalize(queryText).replace(/\s+/gu, "");
    const explicitInn = query.inn;
    if (explicitInn && candidate.inn === explicitInn) {
        lexicalScore += 1000;
        reasons.push("exact-inn");
    }
    if (candidate.code && compactQuery === baseNormalize(candidate.code).replace(/\s+/gu, "")) {
        lexicalScore += 350;
        reasons.push("exact-code");
    }

    const finalScore = lexicalScore + morphologyScore;
    return {
        ref: candidate.ref,
        name: candidate.name,
        fullName: candidate.fullName,
        inn: candidate.inn,
        code: candidate.code,
        legalForm: candidate.legalForm,
        lexicalScore: Number(lexicalScore.toFixed(3)),
        morphologyScore: Number(morphologyScore.toFixed(3)),
        finalScore: Number(finalScore.toFixed(3)),
        score: Number(finalScore.toFixed(3)),
        legalConflict,
        reasons,
    };
}

function searchCounterparties(queryText, index, options = {}) {
    if (typeof queryText !== "string" || !queryText.trim()) throw new TypeError("queryText должен быть непустой строкой");
    const items = Array.isArray(index) ? index : index?.counterparties;
    if (!Array.isArray(items)) throw new TypeError("Нужен индекс контрагентов");
    const limit = options.limit || 5;
    const ranked = items.map(item => scoreCounterparty(queryText, item))
        .filter(item => item.finalScore > 0 && !item.legalConflict)
        .sort((left, right) => right.finalScore - left.finalScore || left.name.localeCompare(right.name, "ru"));
    const candidates = ranked.slice(0, limit);
    const top = candidates[0];
    if (!top || top.finalScore < (options.minimumScore || 80)) {
        return { decision: "not_found", candidate: null, candidates };
    }
    const query = normalizeCounterparty(queryText);
    if (query.inn && top.inn === query.inn) {
        return { decision: "selected", candidate: top, candidates };
    }
    const second = candidates[1];
    if (!second && top.finalScore >= (options.singleCandidateThreshold || 100)) {
        return { decision: "selected", candidate: top, candidates };
    }
    const margin = second ? top.finalScore - second.finalScore : Infinity;
    if (top.finalScore >= (options.autoThreshold || 180)
        && margin >= (options.marginThreshold || 45)
        && !(second && second.finalScore >= 180)) {
        return { decision: "selected", candidate: top, candidates };
    }
    return { decision: "ambiguous", candidate: null, candidates };
}

async function buildCounterpartyIndex(client = oneC) {
    const rows = await fetchCounterparties(client);
    return {
        version: 1,
        generatedAt: new Date().toISOString(),
        count: rows.length,
        counterparties: rows.map(buildCounterpartyDocument),
    };
}

async function verifyCounterparty(ref, catalog) {
    return catalog.resolve("client", ref);
}

module.exports = {
    COUNTERPARTY_FIELDS,
    buildCounterpartyDocument,
    fetchCounterparties,
    buildCounterpartyIndex,
    scoreCounterparty,
    searchCounterparties,
    verifyCounterparty,
};
