import test from 'node:test';
import assert from 'node:assert/strict';
import { translateInterfaceText } from '../../apps/web/src/i18n/interfaceMessages.ts';

test('customer save, download and quantity messages are understandable in Turkish',()=>{
  assert.equal(translateInterfaceText('Quantities saved.','tr'),'Adetler kaydedildi.');
  assert.match(translateInterfaceText('Bosch price list is ready (45,837 rows). Choose where to save it in the file-ready box.','tr'),/Bosch fiyat listesi hazır \(45,837 satır\)/);
  assert.match(translateInterfaceText('Invalid quantity for P550428. Enter a whole number between 1 and 2147483647.','tr'),/P550428 için adet geçersiz/);
  assert.equal(translateInterfaceText('Quantities saved.','en'),'Quantities saved.');
});
