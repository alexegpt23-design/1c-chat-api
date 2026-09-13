const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { renderInvoice, amountInWords, paymentPayload } = require('../invoice-template');
const template = require('../assets/templates/invoice-587.json');
const sample = () => ({ number: 'TEST-999', date: '2026-09-13', organization: { Description: 'ООО ПОС-ИНДУСТРИЯ', ИНН: '2309169824', КПП: '230901001' }, client: { Description: 'Новый покупатель', ИНН: '1234567890' }, contract: { Description: 'Договор № 2026' }, currency: { Description: 'руб.' }, bank: { name: 'АО ТБанк', account: '40702810310000484642', bic: '044525974', correspondent: '30101810145250000974' }, items: [{ name: 'Новая номенклатура', quantity: 2, price: 6100, lineAmount: 12200, total: 12200, vat: 'НДС22', vatAmount: 2200 }], total: 12200, priceIncludesVat: true });

test('сумма прописью: склонения, тысячи, миллионы, ноль, округление и копейки', () => {
    for(const [value, expected] of [[0,'Ноль рублей 00 копеек'], [1.01,'Один рубль 01 копейка'], [2.02,'Два рубля 02 копейки'], [11.11,'Одиннадцать рублей 11 копеек'], [21000.21,'Двадцать одна тысяча рублей 21 копейка'], [22000,'Двадцать две тысячи рублей 00 копеек'], [39000,'Тридцать девять тысяч рублей 00 копеек'], [1000001.05,'Один миллион один рубль 05 копеек'], [1000000000,'Один миллиард рублей 00 копеек']]) assert.equal(amountInWords(value),expected);
    assert.equal(amountInWords(1.999), 'Два рубля 00 копеек');
    assert.throws(()=>amountInWords(-1));
    assert.throws(()=>amountInWords(12,'GBP'));
});

async function inspect(buffer) {
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(buffer) });
    const pdf = await task.promise;
    const pages = [], images = [];
    for(let n=1;n<=pdf.numPages;n++) {
        const page = await pdf.getPage(n);
        pages.push((await page.getTextContent()).items.map(i=>i.str).join(' '));
        const ops = await page.getOperatorList();
        for(let i=0;i<ops.fnArray.length;i++) if(ops.fnArray[i]===OPS.paintImageXObject) {
            const img=await new Promise(resolve=>page.objs.get(ops.argsArray[i][0],resolve));
            images.push(img);
        }
    }
    await task.destroy();
    return {text:pages.join(' '), images};
}

test('PDF содержит извлечённые подпись, печать, логотип и динамический QR без данных старого счёта', async()=>{
    const invoice = sample();
    const { text, images } = await inspect(await renderInvoice(invoice));
    assert.ok(text.includes('TEST-999')); assert.ok(text.includes('Новый покупатель'));
    assert.ok(!text.includes('Минасян')); assert.ok(!text.includes('39 000'));
    for(const name of ['logo','signature','seal']) {
        const asset=template.artwork[name];
        assert.equal(createHash('sha256').update(Buffer.from(asset.png,'base64')).digest('hex'),asset.sha256);
        assert.ok(images.some(image=>image.width===asset.width && image.height===asset.height), name);
    }
    const qr=images.find(image=>image.width===image.height);
    assert.ok(qr);
    const rgba=new Uint8ClampedArray(qr.width*qr.height*4);
    for(let i=0;i<qr.width*qr.height;i++){if(qr.kind===3)rgba.set(qr.data.subarray(i*4,i*4+4),i*4);else {rgba.set(qr.data.subarray(i*3,i*3+3),i*4);rgba[i*4+3]=255;}}
    const decoded=require('jsqr')(rgba,qr.width,qr.height);
    assert.equal(decoded.data,paymentPayload(invoice));
    assert.ok(decoded.data.includes('Sum=1220000'));
    assert.ok(decoded.data.includes('TEST-999')); assert.ok(!decoded.data.includes('587'));
});

test('печать не переносится на чужую организацию, подпись — на другого руководителя', async()=>{
    const otherOrg=sample(); otherOrg.organization.ИНН='1234567890';
    assert.equal((await inspect(await renderInvoice(otherOrg))).images.length,1);
    const otherDirector=sample(); otherDirector.directorRef='00000000-0000-0000-0000-000000000099'; otherDirector.directorName='Другой директор';
    const {images,text}=await inspect(await renderInvoice(otherDirector));
    assert.ok(text.includes('Другой директор'));
    assert.ok(!images.some(image=>image.width===template.artwork.signature.width && image.height===template.artwork.signature.height));
});

test('без реквизитов не печатается QR с подставленным счётом; разделители не внедряют поля', async()=>{
    const invoice=sample(); invoice.bank.account='';
    await assert.rejects(renderInvoice(invoice), { status: 422 });
    invoice.bank.account='40702810310000484642'; invoice.number='x|Sum=1';
    assert.equal(paymentPayload(invoice).split('|Sum=').length,2);
});
