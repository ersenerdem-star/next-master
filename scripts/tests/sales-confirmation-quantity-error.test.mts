import test from 'node:test';
import assert from 'node:assert/strict';
import {salesConfirmationError} from '../../apps/web/src/shared/salesConfirmationError.ts';
import {documentNumberError} from '../../apps/web/src/shared/documentNumberError.ts';

test('quantity-tier rejection explains how to continue in Turkish and English',()=>{
 const error=new Error('SALES_CONFIRMATION_QUANTITY_RECHECK_REQUIRED');
 assert.match(salesConfirmationError(error,'tr') || '',/Güncel tedarikçi seçeneklerini yenileyip/);
 assert.match(salesConfirmationError(error,'en') || '',/Refresh supplier options/);
 assert.match(documentNumberError(new Error('SALES_DRAFT_QUANTITY_RECHECK_REQUIRED'),'tr','fallback'),/yeniden açın/);
});
