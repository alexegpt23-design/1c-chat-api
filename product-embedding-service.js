const DEFAULT_MODEL="Xenova/multilingual-e5-small",DEFAULT_DIMENSION=384;
class EmbeddingUnavailableError extends Error{constructor(message,cause){super(message);this.name="EmbeddingUnavailableError";this.cause=cause}}
function normalizeVector(values){const v=Float32Array.from(values);let sum=0;for(const x of v)sum+=x*x;const norm=Math.sqrt(sum);if(!norm)throw new Error("Пустой embedding");for(let i=0;i<v.length;i++)v[i]/=norm;return v}
function createEmbeddingService(options={}){
 const model=options.model||process.env.PRODUCT_EMBEDDING_MODEL||DEFAULT_MODEL,dimension=Number(options.dimension||process.env.PRODUCT_EMBEDDING_DIMENSION||DEFAULT_DIMENSION),dtype=options.dtype||process.env.PRODUCT_EMBEDDING_DTYPE||"q8";let promise;
 async function loadExtractor(){if(!promise)promise=(async()=>{try{if(options.loader)return await options.loader({model,dtype});const {pipeline,env}=await import("@huggingface/transformers");if(process.env.PRODUCT_EMBEDDING_CACHE_DIR)env.cacheDir=process.env.PRODUCT_EMBEDDING_CACHE_DIR;env.allowRemoteModels=process.env.PRODUCT_EMBEDDING_LOCAL_ONLY!=="true";return pipeline("feature-extraction",model,{dtype})}catch(e){promise=undefined;throw new EmbeddingUnavailableError("Не удалось загрузить embedding-модель",e)}})();return promise}
 async function embedTexts(texts,{kind="passage",batchSize=Number(process.env.PRODUCT_EMBEDDING_BATCH_SIZE)||16}={}){const extractor=await loadExtractor(),result=[];try{for(let i=0;i<texts.length;i+=batchSize){const out=await extractor(texts.slice(i,i+batchSize).map(x=>kind+": "+String(x).trim()),{pooling:"mean",normalize:true});for(const row of out.tolist()){const v=normalizeVector(row);if(v.length!==dimension)throw new Error("Неверная размерность embedding");result.push(v)}}return result}catch(e){throw new EmbeddingUnavailableError("Не удалось вычислить embeddings",e)}}
 return{model,dimension,dtype,loadExtractor,embedTexts,get isLoaded(){return Boolean(promise)}}
}
let singleton;function getEmbeddingService(){return singleton??=createEmbeddingService()}
module.exports={DEFAULT_MODEL,DEFAULT_DIMENSION,EmbeddingUnavailableError,normalizeVector,createEmbeddingService,getEmbeddingService};
