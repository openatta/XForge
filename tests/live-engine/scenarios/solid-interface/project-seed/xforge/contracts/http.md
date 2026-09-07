# http

## Purpose

Established by archived XForge Changes.

## Elements

### Element: openapi:paths./orders.get

- module: api
- List every order.

### Element: openapi:paths./orders.post

- module: api
- Create an order. Returns 201.

### Element: openapi:paths./orders/{id}.get

- module: api
- Read one order. Returns 404 when it is unknown.

### Element: openapi:components.schemas.Order

- module: api
- id, total, status.

### Element: openapi:components.schemas.Order.properties.id

- module: api
- The order's identifier.

### Element: openapi:components.schemas.Order.properties.total

- module: api
- The order total.

### Element: openapi:components.schemas.Order.properties.status

- module: api
- `PENDING | PAID | SHIPPED`
- The value set is open. A consumer reads a value it does not recognise as a state it does not
  handle, and must not switch exhaustively over the recorded values or reject a document for
  carrying one that is absent here. Adding a value is therefore additive under this contract;
  removing or redefining one is not.
