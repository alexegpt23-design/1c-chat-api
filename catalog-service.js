const { oneC } = require("./onec-client");
const { AppError } = require("./errors");
const ZERO = "00000000-0000-0000-0000-000000000000";
const catalogs = {
    client: "Catalog_Контрагенты",
    product: "Catalog_Номенклатура",
    contract: "Catalog_ДоговорыКонтрагентов",
};

function requiredText(value, field) {
    if (typeof value !== "string" || !value.trim() || value.length > 250) {
        throw new AppError(`${field}: нужна непустая строка до 250 символов`);
    }
    return value.trim();
}
function guid(value, field = "ref") {
    if (typeof value !== "string" || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) || value === ZERO) {
        throw new AppError(`${field}: нужен непустой GUID`);
    }
    return value.toLowerCase();
}
function nameFilter(name) {
    const text = requiredText(name, "name");
    return "(" + [...new Set([text, text.toUpperCase(), text.toLowerCase()])]
        .map(value => `substringof('${value.replace(/'/g, "''")}',Description)`).join(" or ") + ")";
}
async function list(entity, filter) {
    const rows = [];
    const pageSize = 200;
    for (let skip = 0; skip < 10000; ) {
        const { data } = await oneC.get(entity, { params: {
            $format: "json", $filter: filter, $orderby: "Ref_Key", $top: pageSize, $skip: skip,
        } });
        const page = data?.value || data?.d?.results;
        if (!Array.isArray(page)) throw new AppError("1С вернула некорректный список OData", 502);
        rows.push(...page);
        skip += page.length;
        if (!page.length || (page.length < pageSize && !data["odata.nextLink"] && !data?.d?.__next)) {
            console.log(`[Поиск] ${entity}: найдено ${rows.length}`);
            return rows;
        }
    }
    throw new AppError("Слишком много результатов; уточните поиск", 422);
}
function summary(kind, row) {
    const result = { ref: row.Ref_Key, name: row.Description };
    if (kind === "client") result.inn = row.ИНН || "";
    if (kind === "contract") Object.assign(result, {
        clientRef: row.Owner_Key, number: row.Номер || "", date: row.Дата,
        type: row.ВидДоговора, closed: row.ДоговорЗакрыт === true, organizationRef: row.Организация_Key,
        currencyRef: row.ВалютаВзаиморасчетов_Key,
    });
    return result;
}
async function search(kind, name, extra = "") {
    return list(catalogs[kind], ["DeletionMark eq false", "IsFolder eq false", name === undefined ? "" : nameFilter(name), extra].filter(Boolean).join(" and "));
}
async function resolve(kind, ref, name, extra = "") {
    const rows = await search(kind, ref ? undefined : name, [ref ? `Ref_Key eq guid'${guid(ref, kind + "Ref")}'` : "", extra].filter(Boolean).join(" and "));
    if (!rows.length) throw new AppError(`Не найден ${kind}`, 404);
    if (rows.length !== 1) throw new AppError(`Найдено несколько ${kind}; укажите ${kind}Ref`, 409, { candidates: rows.map(row => summary(kind, row)) });
    return rows[0];
}
async function findClient(name) { return (await search("client", requiredText(name, "name"))).map(row => summary("client", row)); }
async function findProduct(name) { return (await search("product", requiredText(name, "name"))).map(row => summary("product", row)); }
async function findContracts(clientRef, name) {
    if (!clientRef && name === undefined) throw new AppError("Укажите clientRef или name договора");
    return (await search("contract", name, clientRef ? `Owner_Key eq guid'${guid(clientRef, "clientRef")}'` : "")).map(row => summary("contract", row));
}

module.exports = { ZERO, guid, requiredText, list, resolve, summary, findClient, findProduct, findContracts };
