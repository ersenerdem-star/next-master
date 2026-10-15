import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmOrderForCapability } from '../../apps/web/src/shared/confirmOrderForCapability.ts';

test('existing confirmation remains available when atomic schema capability is absent', async () => {
  const writes: string[] = [];
  const result = await confirmOrderForCapability(false, {
    legacy: async () => { writes.push('existing-confirm'); return 'saved'; },
    atomic: async () => { throw new Error('Unavailable RPC must not be called'); },
  });
  assert.equal(result, 'saved');
  assert.deepEqual(writes, ['existing-confirm']);
});

test('accepted atomic confirmation returns its result without a second legacy write', async () => {
  const result = { salesOrder: { id: 'order-1' }, purchaseOrders: [{ id: 'purchase-1' }], replayed: true };
  assert.equal(await confirmOrderForCapability(true, {
    legacy: async () => { throw new Error('Legacy writes must not run'); },
    atomic: async () => result,
  }), result);
});

test('ambiguous atomic failure never falls back to legacy writes', async () => {
  let legacyWrites = 0;
  await assert.rejects(confirmOrderForCapability(true, {
    legacy: async () => { legacyWrites++; return 'duplicate'; },
    atomic: async () => { throw new Error('Response lost after commit'); },
  }), /Response lost after commit/);
  assert.equal(legacyWrites, 0);
});
