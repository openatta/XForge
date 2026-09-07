// In-memory order store. No dependencies, no I/O: the whole ledger lives for as long as the
// process does, which is all an acceptance run needs.
//
// This module is the bottom of the dependency graph. It must never import from `src/api` —
// the direction is api -> store, and the module-boundaries Gate enforces it.

/**
 * The statuses an order may hold, and the moves the ledger allows between them.
 *
 * A status with no outgoing move is terminal.
 */
const TRANSITIONS = {
  PENDING: ['PAID'],
  PAID: ['SHIPPED'],
  SHIPPED: [],
};

/** Every status the ledger knows, in lifecycle order. */
export const STATUSES = Object.keys(TRANSITIONS);

/** The status every new order starts in. */
export const INITIAL_STATUS = 'PENDING';

/**
 * Hand out a copy so a caller cannot reach back through a returned order and edit the ledger.
 *
 * @param {{ id: string, total: number, status: string }} order
 */
function snapshot(order) {
  return { id: order.id, total: order.total, status: order.status };
}

/**
 * Create an empty order store.
 *
 * @returns {{
 *   create: (input: { id: string, total: number }) => { id: string, total: number, status: string },
 *   get: (id: string) => { id: string, total: number, status: string } | undefined,
 *   list: () => Array<{ id: string, total: number, status: string }>,
 *   setStatus: (id: string, status: string) => { id: string, total: number, status: string },
 * }}
 */
export function createStore() {
  /** @type {Map<string, { id: string, total: number, status: string }>} */
  const orders = new Map();

  return {
    create({ id, total }) {
      const order = { id, total, status: INITIAL_STATUS };
      orders.set(id, order);
      return snapshot(order);
    },

    get(id) {
      const order = orders.get(id);
      return order ? snapshot(order) : undefined;
    },

    list() {
      return [...orders.values()].map(snapshot);
    },

    setStatus(id, status) {
      const order = orders.get(id);
      if (!order) throw new Error(`unknown order: ${id}`);

      const allowed = TRANSITIONS[order.status] ?? [];
      if (!allowed.includes(status)) {
        throw new Error(`illegal transition: ${order.status} -> ${status}`);
      }

      order.status = status;
      return snapshot(order);
    },
  };
}
