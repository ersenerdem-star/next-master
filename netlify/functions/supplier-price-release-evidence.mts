import {handleSupplierReleaseAction} from './_shared/supplier-release-actions.mts';
export default (req:Request)=>handleSupplierReleaseAction(req,'evidence');
export const config={path:'/api/supplier-price-release-evidence'};
