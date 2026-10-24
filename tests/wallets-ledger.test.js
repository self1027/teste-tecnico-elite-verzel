import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertBalanced } from '../src/modules/ledger/services/balance.ts';
import { WalletService } from '../src/modules/wallets/services/wallet-service.ts';

test('ledger validates exact signed BIGINT arithmetic without precision loss', () => {
  assert.doesNotThrow(() => assertBalanced([{ amountCents: 9223372036854775807n }, { amountCents: -9223372036854775807n }]));
  for (const amounts of [[], [1n], [0n, 0n], [9007199254740993n, -9007199254740992n], [9223372036854775808n, -9223372036854775808n]]) {
    assert.throws(() => assertBalanced(amounts.map((amountCents) => ({ amountCents }))), { code: 'UNBALANCED_LEDGER' });
  }
});

test('internal deposit calls reject invalid values and keys before opening a transaction', async () => {
  const service = new WalletService({ transaction() { assert.fail('Invalid input must not open a transaction'); } });
  for (const value of [0n, -1n, 9223372036854775808n]) await assert.rejects(service.deposit('user', value, 'key'), { status: 400 });
  for (const key of ['', 'with spaces', 'x'.repeat(129)]) await assert.rejects(service.deposit('user', 1n, key), { status: 400 });
});
