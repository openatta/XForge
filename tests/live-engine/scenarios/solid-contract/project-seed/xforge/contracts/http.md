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
