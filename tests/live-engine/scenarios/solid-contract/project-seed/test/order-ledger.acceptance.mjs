/*
 * Black-box acceptance suite for the order ledger.
 *
 * It reaches for the two public entry points only — the service surface and the store it sits on —
 * so an implementation is free to reorganise anything behind them.
 *
 * The cancellation cases at the bottom describe work that is NOT done yet. They are expected to
 * fail against the seeded source: they are the specification of the Change under test, written
 * before it, and they turn green only once cancellation actually exists.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApi } from '../src/api/index.mjs';
import { createStore } from '../src/store/index.mjs';

/** A fresh ledger per test: no case may depend on another's leftovers. */
function fixture() {
  const store = createStore();
  return { store, api: createApi(store) };
}

/** Drive an order to `status` through the legal chain, so setup states cost no assertions. */
function seedOrder(fixtureUnderTest, { id, total, status }) {
  const { api, store } = fixtureUnderTest;
  api.createOrder({ id, total });
  for (const step of ['PAID', 'SHIPPED']) {
    if (store.get(id).status === status) break;
    store.setStatus(id, step);
  }
  assert.equal(store.get(id).status, status, 'fixture setup must reach the requested status');
}

test('creates an order and reads it back', () => {
  const { api } = fixture();

  const created = api.createOrder({ id: 'A-1', total: 42 });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { id: 'A-1', total: 42, status: 'PENDING' });

  const read = api.getOrder('A-1');
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, { id: 'A-1', total: 42, status: 'PENDING' });
});

test('lists every order it holds', () => {
  const { api } = fixture();
  assert.deepEqual(api.listOrders(), { status: 200, body: [] });

  api.createOrder({ id: 'A-1', total: 42 });
  api.createOrder({ id: 'A-2', total: 7 });

  const listed = api.listOrders();
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map((order) => order.id).sort(),
    ['A-1', 'A-2'],
  );
  assert.deepEqual(listed.body.find((order) => order.id === 'A-2'), {
    id: 'A-2',
    total: 7,
    status: 'PENDING',
  });
});

test('answers 404 for an order it does not hold', () => {
  const { api, store } = fixture();

  const missing = api.getOrder('nope');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, 'string');
  assert.match(missing.body.error, /nope/);

  assert.equal(store.get('nope'), undefined);
});

test('walks an order along the legal transitions', () => {
  const { api, store } = fixture();
  api.createOrder({ id: 'A-1', total: 42 });

  assert.equal(store.setStatus('A-1', 'PAID').status, 'PAID');
  assert.equal(api.getOrder('A-1').body.status, 'PAID');

  assert.equal(store.setStatus('A-1', 'SHIPPED').status, 'SHIPPED');
  assert.equal(api.getOrder('A-1').body.status, 'SHIPPED');
});

test('refuses an illegal transition, and an unknown order, by name', () => {
  const { api, store } = fixture();
  api.createOrder({ id: 'A-1', total: 42 });

  // Skipping PAID is not a move the ledger offers, and the refusal names both ends of it.
  assert.throws(
    () => store.setStatus('A-1', 'SHIPPED'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /PENDING/);
      assert.match(error.message, /SHIPPED/);
      return true;
    },
  );
  assert.equal(api.getOrder('A-1').body.status, 'PENDING', 'a refused move must change nothing');

  assert.throws(() => store.setStatus('ghost', 'PAID'), /ghost/);
});

/* ------------------------------------------------------------------------------------------------
 * Cancellation — the behaviour this Change adds. Expected to fail until it exists.
 * ---------------------------------------------------------------------------------------------- */

test('cancels a pending order', () => {
  const context = fixture();
  seedOrder(context, { id: 'A-1', total: 42, status: 'PENDING' });

  const cancelled = context.api.cancelOrder('A-1');
  assert.equal(cancelled.status, 200);
  assert.equal(context.api.getOrder('A-1').body.status, 'CANCELLED');
  assert.equal(context.store.get('A-1').status, 'CANCELLED');
});

test('refuses to cancel a shipped order, and leaves it shipped', () => {
  const context = fixture();
  seedOrder(context, { id: 'A-1', total: 42, status: 'SHIPPED' });

  const refused = context.api.cancelOrder('A-1');
  assert.equal(refused.status, 409);
  assert.equal(context.api.getOrder('A-1').body.status, 'SHIPPED');
  assert.equal(context.store.get('A-1').status, 'SHIPPED');
});

test('answers 404 when cancelling an order it does not hold', () => {
  const { api } = fixture();

  const missing = api.cancelOrder('nope');
  assert.equal(missing.status, 404);
  assert.equal(typeof missing.body.error, 'string');
});
