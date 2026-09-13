const fs = require("node:fs");
const path = require("node:path");
const { baseNormalize, analyzeProductText } = require("./product-search-normalizer");

function intersectionCount(left, right) {
    const set = new Set(right);
    return left.reduce((count, value) => count + (set.has(value) ? 1 : 0), 0);
}

function hasOverlap(left, right) {
    return left.some(value => right.includes(value));
}

function compact(value) {
    return baseNormalize(value).replace(/[^а-яa-z0-9]/giu, "");
}

function scoreProduct(queryText, product) {
    const query = analyzeProductText(queryText, { inferBareDuration: true });
    const candidate = product.normalizedText ? product : { ...product, ...analyzeProductText([product.name, product.fullName, product.code, product.article].filter(Boolean).join(" ")) };
    const reasons = [];
    let score = 0;

    const queryBase = baseNormalize(queryText);
    const nameBase = baseNormalize(candidate.name);
    const fullBase = baseNormalize(candidate.fullName);
    if (queryBase === nameBase || queryBase === fullBase) {
        score += 100;
        reasons.push("exact-name");
    } else if (nameBase.includes(queryBase) || fullBase.includes(queryBase) || candidate.normalizedText.includes(query.normalizedText)) {
        score += 35;
        reasons.push("phrase");
    }

    const covered = intersectionCount(query.tokens, candidate.tokens);
    const coverage = covered / Math.max(query.tokens.length, 1);
    score += coverage * 45;
    if (covered) reasons.push("token-coverage:" + coverage.toFixed(2));

    const queryCompact = compact(queryText);
    if (queryCompact && [candidate.code, candidate.article].some(value => value && compact(value) === queryCompact)) {
        score += 140;
        reasons.push("exact-code-or-article");
    }

    if (query.models.length) {
        if (hasOverlap(query.models, candidate.models)) {
            score += 65;
            reasons.push("exact-model");
        } else if (candidate.models.length) {
            score -= 140;
            reasons.push("model-conflict");
        } else {
            score -= 30;
            reasons.push("model-missing");
        }
    }

    const queryMonths = query.attributes.months;
    const candidateMonths = candidate.attributes?.months || [];
    if (queryMonths.length) {
        if (hasOverlap(queryMonths, candidateMonths)) {
            score += 55;
            reasons.push("exact-duration");
        } else if (candidateMonths.length) {
            score -= 120;
            reasons.push("duration-conflict");
        } else {
            score -= 25;
            reasons.push("duration-missing");
        }
    }

    const queryCategories = query.attributes.categories || [];
    const candidateCategories = candidate.attributes?.categories || [];
    for (const category of ["fn", "kkt", "ofd"]) {
        if (queryCategories.includes(category) && candidateCategories.includes(category)) {
            score += 28;
            reasons.push("category:" + category);
        }
    }
    const primaryCategories = ["fn", "kkt", "ofd"];
    const requestedPrimary = primaryCategories.filter(category => queryCategories.includes(category));
    const candidatePrimary = primaryCategories.filter(category => candidateCategories.includes(category));
    if (requestedPrimary.length && candidatePrimary.length && !hasOverlap(requestedPrimary, candidatePrimary)) {
        score -= 80;
        reasons.push("category-conflict");
    }
    if (queryCategories.includes("kkt") && candidateCategories.includes("part")) {
        score -= 55;
        reasons.push("part-penalty");
    }
    if (query.models.length && candidateCategories.includes("kkt")) {
        score += 24;
        reasons.push("modeled-kkt");
    }
    if (query.models.length && candidateCategories.includes("part")) {
        score -= 45;
        reasons.push("modeled-part-penalty");
    }
    if (queryCategories.includes("part") && candidateCategories.includes("part")) {
        score += 85;
        reasons.push("requested-part");
    }
    if (queryCategories.includes("part") && candidateCategories.includes("kkt")) {
        score -= 85;
        reasons.push("whole-product-penalty");
    }

    if (query.attributes.hardwareIntent && candidate.isService === true) {
        score -= 130;
        reasons.push("service-for-hardware-penalty");
    }
    if (query.attributes.serviceIntent && candidate.isService === true) {
        score += 70;
        reasons.push("requested-service");
    }

    const queryServiceSubtypes = query.attributes.serviceSubtypes || [];
    const analyzedCandidate = analyzeProductText(
        [candidate.name, candidate.fullName].filter(Boolean).join(" "),
        { isService: candidate.isService === true },
    );
    const candidateServiceSubtypes = candidate.attributes?.serviceSubtypes
        || analyzedCandidate.attributes.serviceSubtypes;
    let serviceSubtypeAdjustment = 0;
    if (query.attributes.serviceIntent && queryServiceSubtypes.length
        && !queryServiceSubtypes.includes("other_service")
        && candidate.isService === true) {
        if (hasOverlap(queryServiceSubtypes, candidateServiceSubtypes)) {
            serviceSubtypeAdjustment = 150;
            score += serviceSubtypeAdjustment;
            reasons.push("service-subtype-match:" + queryServiceSubtypes.find(value => candidateServiceSubtypes.includes(value)));
        } else if (candidateServiceSubtypes.length && !candidateServiceSubtypes.includes("other_service")) {
            serviceSubtypeAdjustment = -190;
            score += serviceSubtypeAdjustment;
            reasons.push("service-subtype-conflict");
        } else {
            serviceSubtypeAdjustment = -35;
            score += serviceSubtypeAdjustment;
            reasons.push("service-subtype-missing");
        }
    }

    if (query.attributes.withoutFn) {
        if (candidate.attributes?.withoutFn) {
            score += 35;
            reasons.push("without-fn");
        } else {
            score -= 45;
            reasons.push("without-fn-conflict");
        }
    }

    const queryColors = query.attributes.color || [];
    const candidateColors = candidate.attributes?.color || [];
    if (queryColors.length) {
        if (hasOverlap(queryColors, candidateColors)) {
            score += 24;
            reasons.push("color");
        } else if (candidateColors.length) {
            score -= 50;
            reasons.push("color-conflict");
        } else {
            score -= 12;
            reasons.push("color-missing");
        }
    }

    return {
        ref: candidate.ref,
        name: candidate.name,
        code: candidate.code || "",
        article: candidate.article || "",
        score: Number(score.toFixed(3)),
        reasons,
        serviceSubtype: candidateServiceSubtypes[0] || null,
        serviceSubtypes: candidateServiceSubtypes,
        queryServiceSubtype: queryServiceSubtypes[0] || null,
        serviceSubtypeAdjustment,
    };
}

function searchProducts(queryText, index, options = {}) {
    if (typeof queryText !== "string" || !queryText.trim()) throw new TypeError("queryText должен быть непустой строкой");
    const products = Array.isArray(index) ? index : index?.products;
    if (!Array.isArray(products)) throw new TypeError("Нужен индекс номенклатуры");
    const limit = options.limit || 5;
    const ranked = products.map(product => scoreProduct(queryText, product))
        .filter(candidate => candidate.score > 0)
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"));
    const candidates = ranked.slice(0, limit);
    const top = candidates[0];
    if (!top || top.score < (options.minimumScore || 35)) {
        return { decision: "not_found", candidate: null, candidates };
    }
    const second = candidates[1];
    const margin = second ? top.score - second.score : Infinity;
    const autoThreshold = options.autoThreshold || 105;
    const marginThreshold = options.marginThreshold || 22;
    const hasStrongAlternative = second && second.score >= 80;
    if (top.score >= autoThreshold && margin >= marginThreshold && !hasStrongAlternative) {
        return { decision: "selected", candidate: top, candidates };
    }
    return { decision: "ambiguous", candidate: null, candidates };
}

function loadProductIndex(indexPath = process.env.PRODUCT_SEARCH_INDEX_PATH || path.join(__dirname, "data", "product-index.json")) {
    return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

function searchProductIndex(queryText, options = {}) {
    return searchProducts(queryText, options.index || loadProductIndex(options.indexPath), options);
}

function dot(left,right){if(left.length!==right.length)throw new Error("Размерности embeddings не совпадают");let n=0;for(let i=0;i<left.length;i++)n+=left[i]*right[i];return n}
function decideRanked(ranked,o={}){const candidates=ranked.filter(x=>x.finalScore>0).slice(0,o.limit||5),top=candidates[0];if(!top||top.finalScore<(o.minimumScore||45))return{decision:"not_found",candidate:null,candidates};const second=candidates[1],margin=second?top.finalScore-second.finalScore:Infinity;if(top.finalScore>=(o.autoThreshold||125)&&margin>=(o.marginThreshold||25)&&!(second&&second.finalScore>=90))return{decision:"selected",candidate:top,candidates};return{decision:"ambiguous",candidate:null,candidates}}
async function searchProductIndexHybrid(queryText,o={}){try{const{loadEmbeddingBundle}=require("./product-embedding-index"),{getEmbeddingService}=require("./product-embedding-service"),bundle=o.bundle||loadEmbeddingBundle(o),service=o.embeddingService||getEmbeddingService();if(service.model!==bundle.metadata.model||service.dimension!==bundle.metadata.dimension)throw new Error("Embedding model не соответствует индексу");const[queryVector]=await service.embedTexts([queryText],{kind:"query"});const ranked=bundle.index.products.map((product,i)=>{const lexical=scoreProduct(queryText,product),semanticScore=dot(queryVector,bundle.vectors[i]),blocked=lexical.reasons.some(x=>/(?:model|duration|category|without-fn|color|service-subtype)-conflict/.test(x)),semanticContribution=blocked?0:Math.max(0,Math.min(60,(semanticScore-.65)*200)),finalScore=lexical.score+semanticContribution;return{...lexical,lexicalScore:lexical.score,semanticScore:Number(semanticScore.toFixed(6)),finalScore:Number(finalScore.toFixed(3)),score:Number(finalScore.toFixed(3))}}).sort((a,b)=>b.finalScore-a.finalScore||a.name.localeCompare(b.name,"ru"));return{...decideRanked(ranked,o),embeddingStatus:"available"}}catch(error){if(o.requireEmbeddings)throw error;const lexical=searchProducts(queryText,o.index||loadProductIndex(o.indexPath),{...o,autoThreshold:Math.max(o.autoThreshold||0,125)}),map=x=>({...x,lexicalScore:x.score,semanticScore:null,finalScore:x.score});return{...lexical,candidate:lexical.candidate?map(lexical.candidate):null,candidates:lexical.candidates.map(map),embeddingStatus:"unavailable",embeddingError:error.message}}}

module.exports = { scoreProduct, searchProducts, loadProductIndex, searchProductIndex, searchProductIndexHybrid, dot, decideRanked };
