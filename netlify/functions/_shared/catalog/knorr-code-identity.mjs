// Source identity and local canonical key have different purposes. Never
// silently coalesce two manufacturer identities that reduce to the same key.
export function knorrCodeIdentity(sourceCode){
 if(typeof sourceCode!=='string'||!sourceCode||sourceCode!==sourceCode.trim()||sourceCode.length>100||!/^[A-Z0-9][A-Z0-9.\/-]*$/.test(sourceCode))throw Error('KNORR_SOURCE_CODE_INVALID');
 const canonical=sourceCode.replace(/[^A-Z0-9]/g,'');if(!canonical||canonical.length>80)throw Error('KNORR_CANONICAL_CODE_INVALID');
 return {sourceCode,canonicalCode:canonical,requiresCollisionReview:sourceCode!==canonical};
}
export function assessKnorrCanonicalIdentity({sourceCode,officialCode,canonicalMatches=[]}={}){
 const id=knorrCodeIdentity(sourceCode);if(officialCode!==id.sourceCode)throw Error('KNORR_OFFICIAL_IDENTITY_MISMATCH');
 if(!Array.isArray(canonicalMatches)||canonicalMatches.length>100)throw Error('KNORR_IDENTITY_MATCHES_INVALID');
 const foreign=canonicalMatches.filter(v=>typeof v!=='string'||knorrCodeIdentity(v).canonicalCode!==id.canonicalCode||v!==id.sourceCode);
 return {...id,status:foreign.length?'collision':id.requiresCollisionReview?'review_required':'exact',foreignIdentities:foreign,canonicalWrite:false};
}

// A bounded manufacturer search is supporting evidence only. The source's
// recall contract is unknown, so even a complete result remains review-only.
export function verifyKnorrSearchIdentity(sourceCode,payload){
 const id=knorrCodeIdentity(sourceCode),p=payload?.pagination,products=payload?.products;
 if(!p||p.currentPage!==0||!Number.isInteger(p.totalResults)||p.totalResults<1||p.totalResults>100||p.totalPages!==1||!Array.isArray(products)||products.length!==p.totalResults)throw Error('KNORR_SEARCH_IDENTITY_INCOMPLETE');
 const codes=products.map(x=>x?.code);if(codes.some(c=>typeof c!=='string')||new Set(codes).size!==codes.length)throw Error('KNORR_SEARCH_IDENTITY_INVALID');
 if(!codes.includes(sourceCode))throw Error('KNORR_SEARCH_IDENTITY_MISMATCH');
 const identities=codes.map(code=>{try{return knorrCodeIdentity(code)}catch{throw Error('KNORR_SEARCH_IDENTITY_INVALID')}});
 const collisions=identities.filter(row=>row.canonicalCode===id.canonicalCode&&row.sourceCode!==sourceCode).map(row=>row.sourceCode);
 return {...id,status:collisions.length?'collision':'search_consistent',foreignIdentities:collisions,canonicalWrite:false};
}

// An existing catalog record is associated with an official code only through
// its own exact source record. Search similarity or a shared compact key does
// not prove that the record belongs to the requested manufacturer article.
export function assessKnorrRecordedOwnership({sourceCode,catalogCode,sourceRecords=[]}={}){
 const wanted=knorrCodeIdentity(sourceCode);const catalog=knorrCodeIdentity(catalogCode);
 if(catalog.canonicalCode!==wanted.canonicalCode)throw Error('KNORR_CATALOG_KEY_MISMATCH');
 if(!Array.isArray(sourceRecords)||sourceRecords.length>1000)throw Error('KNORR_SOURCE_RECORDS_INVALID');
 const recorded=[];
 for(const row of sourceRecords){
  if(row?.source_key!=='knorr_bremse_aftermarket')continue;
  if(typeof row.source_product_id!=='string'||!/^[a-f0-9]{64}$/.test(row.payload_fingerprint||''))throw Error('KNORR_SOURCE_RECORD_INVALID');
  const id=knorrCodeIdentity(row.source_product_id);if(id.canonicalCode!==wanted.canonicalCode)throw Error('KNORR_SOURCE_RECORD_KEY_MISMATCH');
  recorded.push(id.sourceCode);
 }
 const distinct=[...new Set(recorded)];
 return {sourceCode:wanted.sourceCode,canonicalCode:wanted.canonicalCode,status:distinct.length>1||distinct.length===1&&distinct[0]!==wanted.sourceCode?'collision':distinct.length===1?'source_record_matched':'unproven',sourceCodes:distinct,canonicalWrite:false};
}
