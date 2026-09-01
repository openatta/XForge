// Service layer over the order store. One method per HTTP operation the OpenAPI document
// declares, each returning the status code and body that operation would put on the wire, so the
// transport itself stays trivial and the acceptance suite can drive the surface in-process.
//
// Imports run one way only: api -> store. Nothing here may be imported back into `src/store`.

/** Body returned for an order the ledger does not hold. */
function notFound(id) {
  return { error: `unknown order: ${id}` };
}

/**
 * Wrap a store in the HTTP-shaped surface.
 *
 * @param {ReturnType<import('../store/index.mjs').createStore>} store
 */
export function createApi(store) {
  return {
    /** GET /orders */
    listOrders() {
      return { status: 200, body: store.list() };
    },

    /** POST /orders */
    createOrder({ id, total }) {
      return { status: 201, body: store.create({ id, total }) };
    },

    /** GET /orders/{id} */
    getOrder(id) {
      const order = store.get(id);
      if (!order) return { status: 404, body: notFound(id) };
      return { status: 200, body: order };
    },
  };
}
