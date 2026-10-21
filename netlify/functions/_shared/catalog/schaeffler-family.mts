import {normalizeBrandKey} from './brand-standardization.mts';

// One official connector family; brand remains part of every product identity.
export const SCHAEFFLER_ENGINE = {
  name: 'Schaeffler',
  family: 'schaeffler',
  sourceKey: 'schaeffler_aftermarket',
  sourceUrl: 'https://vehiclelifetimesolutions.schaeffler.com/en/catalog',
  brands: ['FAG', 'INA', 'LuK', 'Vitesco'],
} as const;

export const isSchaefflerBrand = (brand:string) =>
  SCHAEFFLER_ENGINE.brands.some(member => normalizeBrandKey(member) === normalizeBrandKey(brand));
