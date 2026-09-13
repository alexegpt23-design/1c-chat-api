const { syncEmbeddingIndex } = require("../product-embedding-index");
const started=Date.now();
syncEmbeddingIndex().then(({metadata})=>console.log("Индекс и embeddings построены:",metadata.count,"изменено:",metadata.changedVectors,"повторно:",metadata.reusedVectors,"время:",Date.now()-started,"мс")).catch(error=>{console.error("Не удалось построить индекс:",error.message);process.exitCode=1});
