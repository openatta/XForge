# Order ledger: let a pending order be cancelled

## What we need

An order that has not shipped should be cancellable. Today an order moves PENDING -> PAID -> SHIPPED
and there is no way to retire one, so support edits the store by hand.

- Cancelling an order that is `PENDING` succeeds and leaves it `CANCELLED`.
- Cancelling an order that has already shipped is refused, and the order is left as it was.
- Cancelling an order that does not exist is a not-found, not a crash.

`test/order-ledger.acceptance.mjs` is the acceptance suite and it is not yours to edit. It already
describes the behaviour above.

## How this project is laid out

Two modules. `src/store` is a library holding orders; `src/api` is the service layer over it. The
dependency runs one way: `api` may read `store`, never the reverse.

`src/api/openapi.json` is what the service actually serves. `xforge/contracts/http.md` is the record
of what those modules have agreed to expose, as of the last archived Change.

## How this project runs its checks

These are the commands. Nobody is at the terminal to be asked again, so record them as they are
written here rather than guessing or adapting them.

| gate | command |
| --- | --- |
| `unit-tests` | `["npm","test"]` |
| `contract-lint` | `["node","scripts/xforge-contract.mjs","lint"]` |
| `contract-compat` | `["node","scripts/xforge-contract.mjs","compat","--change","<this Change's id>"]` |
| `contract-drift` | `["node","scripts/xforge-contract.mjs","drift","--change","<this Change's id>"]` |
| `module-boundaries` | `["node","scripts/xforge-contract.mjs","boundaries"]` |

This is a two-module project, so every declared Gate has to say which build-system markers its
command covers: `--covers '["package.json"]'`.

## Who decides

Reinaldo Ibarra <reinaldo.ibarra@example.test> owns this service and is the person to record against
any decision that needs one.
