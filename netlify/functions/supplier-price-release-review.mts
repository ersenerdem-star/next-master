import {handleSupplierReleaseAction} from './_shared/supplier-release-actions.mts';
export default (req:Request)=>handleSupplierReleaseAction(req,'review');
export const config={path:'/api/supplier-price-release-review'};
