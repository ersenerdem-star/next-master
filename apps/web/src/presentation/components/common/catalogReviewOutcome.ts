type ReviewItem={observation:{before:Record<string,unknown>;fields:Record<string,unknown>;sourceFields?:Record<string,unknown>}|null;result:{fields?:Record<string,string>}};
// Older application receipts call an omitted patch "source_missing" even when
// the planner preserved a supplied value. Keep that receipt intact and explain
// the reviewed outcome using its recorded source and before values.
export function catalogReviewOutcome(item:ReviewItem,field:string){
 const result=item.result.fields?.[field],observation=item.observation;
 if(result!=='source_missing'||!observation)return result;
 const source=observation.sourceFields?.[field],before=observation.before[field];
 if(source==null||source===''||observation.fields[field]!=null)return result;
 if(JSON.stringify(source)===JSON.stringify(before))return 'unchanged';
 if(before!=null&&before!=='')return 'existing_value_preserved';
 return result;
}
