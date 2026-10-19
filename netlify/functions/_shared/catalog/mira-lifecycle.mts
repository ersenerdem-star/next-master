import {zfReplacementCandidates} from './zf-product-identity.mjs';
/** Lifecycle evidence is review-only. Availability and replacement are NOT discontinuation. */
type Row = Record<string, any>;
export const LIFECYCLE_FIELDS = ["replacement", "discontinued"] as const;
export const LIFECYCLE_CONTRACT = "mira-lifecycle.v1";
export const lifecycleCode = (v: unknown) => String(v ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase();
const brandKey = (v: unknown) => String(v ?? "").normalize("NFKC").trim().toLowerCase();
export const isExplicitDiscontinued = (v: unknown) => /^(discontinued|discontinued article|production discontinued|no longer produced|end of production|production ended)$/i.test(String(v ?? "").trim());
const validCode = (v: unknown) => typeof v === "string" && /^[A-Z0-9][A-Z0-9 .\/-]{1,59}$/i.test(v.trim()) && /\d/.test(v);
export type LifecycleResult = {values: Row; evidence: Row; checks: Record<string, string>};

/** Each directed edge describes old -> new; unrelated/accessory/OEM numbers never enter here. */
export function lifecycleEvidence(article: Row, input: {replaces?: unknown; replacedBy?: unknown; status?: unknown; statusSupported?: boolean}): LifecycleResult {
  const edges: Row[] = [];
  const checks: Record<string,string> = {replacement:"unsupported", discontinued:input.statusSupported ? "no_explicit_signal" : "unsupported"};
  let rejected = 0;
  for (const [key, direction] of [["replaces","replaces"],["replacedBy","replaced_by"]] as const) {
    const entries = input[key];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries) || entries.length > 50) throw new Error("SOURCE_LIFECYCLE_SCHEMA_CHANGED");
    checks.replacement="no_explicit_signal";
    for (const entry of entries) {
      // Missing manufacturer is not evidence that the target belongs to this brand.
      const sameBrand = entry && (entry.mfrName ? brandKey(entry.mfrName) === brandKey(article.mfrName)
        : article.mfrId != null && entry.mfrId != null && String(article.mfrId) === String(entry.mfrId));
      if (!sameBrand || !validCode(entry.articleNumber) || lifecycleCode(entry.articleNumber) === lifecycleCode(article.articleNumber)) { rejected++; continue; }
      const oldCode = direction === "replaces" ? entry.articleNumber.trim() : article.articleNumber;
      const newCode = direction === "replaces" ? article.articleNumber : entry.articleNumber.trim();
      // The source evidence keeps 3K; internal replacement links use the approved canonical label.
      const relationBrand = brandKey(article.mfrName) === "borgwarner (3k)" ? "BorgWarner (KKK)" : article.mfrName;
      edges.push({brand:relationBrand,old_code:oldCode,new_code:newCode,source_relation:direction});
    }
  }
  const unique = [...new Map(edges.map(e=>[`${lifecycleCode(e.old_code)}>${lifecycleCode(e.new_code)}`,e])).values()];
  if(unique.length>20) throw new Error("SOURCE_LIFECYCLE_BOUND_EXCEEDED");
  if (unique.some(e=>unique.some(other=>lifecycleCode(e.old_code)===lifecycleCode(other.new_code) && lifecycleCode(e.new_code)===lifecycleCode(other.old_code)))) throw new Error("SOURCE_LIFECYCLE_DIRECTION_CONFLICT");
  const values:Row={}, evidence:Row={};
  if (unique.length) {
    unique.sort((a,b)=>`${a.old_code}>${a.new_code}`.localeCompare(`${b.old_code}>${b.new_code}`));
    values.replacement=JSON.stringify(unique); checks.replacement="found";
    evidence.replacement={contract:LIFECYCLE_CONTRACT,relations:unique,rejected_relations:rejected,review_only:true};
  } else if(rejected) checks.replacement="unverified_target_identity";
  if(input.statusSupported && isExplicitDiscontinued(input.status)) {
    values.lifecycle_status="discontinued"; checks.discontinued="found";
    evidence.discontinued={contract:LIFECYCLE_CONTRACT,source_status:String(input.status).trim(),review_only:true};
  }
  return {values,evidence,checks};
}

export function tecLifecycle(article:Row): LifecycleResult {
  return lifecycleEvidence(article,{replaces:article.replacesArticles,replacedBy:article.replacedByArticles,
    status:article.misc?.articleStatusDescription,statusSupported:typeof article.misc?.articleStatusDescription==="string"});
}

const plain = (s:string) => s.replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
/** The exact-product basic-info fragment, not the whole page/related-products/search results. */
export function borgwarnerLifecycle(html:string, article:Row): LifecycleResult {
  const rows = [...html.matchAll(/<div class="info-label">([\s\S]*?)<\/div>\s*<div class="info-value">([\s\S]*?)<\/div>/g)];
  const info = Object.fromEntries(rows.map(m=>[plain(m[1]),plain(m[2])]));
  if(brandKey(info.Brand)!==brandKey(article.mfrName) || lifecycleCode(info["Article number"])!==lifecycleCode(article.articleNumber)) throw new Error("EXACT_IDENTITY_MISMATCH");
  const input:Row={status:info["Article status"],statusSupported:typeof info["Article status"]==="string"};
  for(const m of html.matchAll(/<div class="replaces-title">(Replaces|Replaced by)<\/div>[\s\S]*?<div class="replaces-links">([\s\S]*?)<\/div>/g)) {
    const key=m[1]==="Replaces"?"replaces":"replacedBy";
    if(input[key]) throw new Error("SOURCE_LIFECYCLE_SCHEMA_CHANGED");
    input[key]=[...m[2].matchAll(/<a\b[^>]*class="replaces-link"[^>]*>([\s\S]*?)<\/a>/g)].map(a=>({articleNumber:plain(a[1]),mfrName:article.mfrName}));
  }
  return lifecycleEvidence(article,input);
}

export function zfLifecycle(payload:Row,article:Row): LifecycleResult {
  const d=payload.details;
  // Do not interpret numeric status IDs. Only the official human-readable production status.
  const candidates=zfReplacementCandidates(d);
  const entries=(direction:string)=>candidates.filter((r:Row)=>r.direction===direction).map((r:Row)=>({articleNumber:r.code,mfrName:r.brand}));
  return lifecycleEvidence(article,{status:d.status?.value,statusSupported:typeof d.status?.value==='string',
    replacedBy:entries('replaced_by'),replaces:entries('replaces')});
}

export function lifecycleCapability(adapterId:string|undefined) {
  return ["corteco-pilot","tecalliance-official","delphi-official","borgwarner-official","zf-official","mann-official","skf-official","meyle-official","driv-official","valeo-official","ate-official","hella-official","garrett-official","schaeffler-official","valeo-europe-official","bosch-public-official","hepu-official","knorr-official"].includes(adapterId || "")
    ? "explicit_official_evidence_only" : "reader_not_available";
}
