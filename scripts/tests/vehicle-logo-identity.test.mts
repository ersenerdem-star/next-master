import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {resolveNamedLogo,resolveVehicleLogo} from '../../apps/web/src/presentation/components/common/logoAssets.ts';
import {VehicleBadges} from '../../apps/web/src/presentation/components/common/VehicleBadges.tsx';

test('vehicle identities cannot pick parts-supplier logos through substrings',()=>{
 for(const name of ['WIESMANN','ALPINA','MANN','MANN-FILTER','INA','FAG','BOSCH','Unknown BMW Company'])assert.equal(resolveVehicleLogo(name),null,name);
 assert.equal(resolveNamedLogo('MANN-FILTER')?.src,'/brand-logos/mann_logo.png');
 assert.equal(resolveNamedLogo('INA')?.src,'/brand-logos/ina_logo.png');
});
test('known vehicle identities and explicit aliases keep their vehicle logos',()=>{
 assert.equal(resolveVehicleLogo('MAN')?.src,'/brand-logos/man_logo.png');
 assert.equal(resolveVehicleLogo('Mercedes-Benz')?.src,'/brand-logos/mercedes-benz-star.svg');
 assert.equal(resolveVehicleLogo('VW')?.label,'Volkswagen');
 assert.equal(resolveVehicleLogo('Citroën')?.label,'Citroen');
 assert.equal(resolveVehicleLogo('ŠKODA')?.label,'Skoda');
});
test('rendered catalog and portal compatibility badges keep WIESMANN and ALPINA as text',()=>{
 const html=renderToStaticMarkup(createElement(VehicleBadges,{value:'BMW, WIESMANN, ALPINA, MAN',logoOnly:true,limit:5}));
 assert.match(html,/title="WIESMANN"/);assert.match(html,/>WIE</);assert.match(html,/title="ALPINA"/);
 assert.match(html,/bmw_logo\.jpeg/);assert.match(html,/man_logo\.png/);
 assert.doesNotMatch(html,/mann_logo|ina_logo/);
});
