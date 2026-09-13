const fs = require("node:fs");
const path = require("node:path");
const { oneC } = require("./onec-client");
const { analyzeProductText } = require("./product-search-normalizer");

const PRODUCT_FIELDS = [
    "Ref_Key", "DataVersion", "Code", "Description", "НаименованиеПолное", "Артикул",
    "ВидНоменклатуры_Key", "НоменклатурнаяГруппа_Key", "Parent_Key", "Услуга",
];

function buildSearchDocument(row) {
    const searchable = [row.Description, row.НаименованиеПолное, row.Code, row.Артикул].filter(Boolean).join(" ");
    const analysis = analyzeProductText(searchable, { isService: row.Услуга === true });
    return {
        ref: row.Ref_Key,
        dataVersion: row.DataVersion,
        code: row.Code || "",
        article: row.Артикул || "",
        name: row.Description || "",
        fullName: row.НаименованиеПолное || "",
        groupRef: row.НоменклатурнаяГруппа_Key || "",
        typeRef: row.ВидНоменклатуры_Key || "",
        parentRef: row.Parent_Key || "",
        isService: row.Услуга === true,
        ...analysis,
    };
}

async function fetchProductCatalog(client = oneC) {
    const rows = [];
    const pageSize = 200;
    for (let skip = 0; skip < 10000;) {
        const { data } = await client.get("Catalog_Номенклатура", { params: {
            $format: "json",
            $select: PRODUCT_FIELDS.join(","),
            $filter: "DeletionMark eq false and IsFolder eq false",
            $orderby: "Ref_Key",
            $top: pageSize,
            $skip: skip,
        } });
        const page = data?.value || data?.d?.results;
        if (!Array.isArray(page)) throw new Error("1С вернула некорректный список номенклатуры");
        rows.push(...page);
        skip += page.length;
        if (page.length < pageSize && !data["odata.nextLink"] && !data?.d?.__next) break;
    }
    return rows;
}

async function syncProductIndex(options = {}) {
    const outputPath = options.outputPath || process.env.PRODUCT_SEARCH_INDEX_PATH
        || path.join(__dirname, "data", "product-index.json");
    const rows = await fetchProductCatalog(options.client || oneC);
    const index = {
        version: 1,
        generatedAt: new Date().toISOString(),
        count: rows.length,
        products: rows.map(buildSearchDocument),
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = outputPath + ".tmp-" + process.pid;
    fs.writeFileSync(temporary, JSON.stringify(index, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, outputPath);
    return index;
}

module.exports = { PRODUCT_FIELDS, buildSearchDocument, fetchProductCatalog, syncProductIndex };
