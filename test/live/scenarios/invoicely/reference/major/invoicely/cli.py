from __future__ import annotations

import argparse
import json
import sys
from datetime import date

from . import core
from .models import LineItem
from .store import JsonStore


def _parse_item(text: str) -> LineItem:
    try:
        description, quantity, unit_price = text.rsplit(":", 2)
        return LineItem(description=description, quantity=int(quantity), unit_price=float(unit_price))
    except ValueError as error:
        raise argparse.ArgumentTypeError(f"item must be desc:qty:price, got {text!r}") from error


def _invoice_row(invoice) -> dict:
    total = core.invoice_total(invoice)
    return {
        "id": invoice.id,
        "customer_id": invoice.customer_id,
        "issued_on": invoice.issued_on.isoformat(),
        "due_on": invoice.due_on.isoformat(),
        "total": str(total.amount),
        "currency": total.currency,
        "status": invoice.status,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="invoicely")
    parser.add_argument("--store", default="invoicely.json")
    sub = parser.add_subparsers(dest="entity", required=True)

    customer = sub.add_parser("customer").add_subparsers(dest="action", required=True)
    add = customer.add_parser("add")
    add.add_argument("name")
    add.add_argument("email")

    invoice = sub.add_parser("invoice").add_subparsers(dest="action", required=True)
    create = invoice.add_parser("create")
    create.add_argument("customer_id")
    create.add_argument("--issued", type=date.fromisoformat, required=True)
    create.add_argument("--due", type=date.fromisoformat, required=True)
    create.add_argument("--tax", type=float, default=0.0)
    create.add_argument("--currency", default="USD")
    create.add_argument("--item", type=_parse_item, action="append", required=True)
    listing = invoice.add_parser("list")
    listing.add_argument("--customer")

    rate = sub.add_parser("rate").add_subparsers(dest="action", required=True)
    rset = rate.add_parser("set")
    rset.add_argument("base")
    rset.add_argument("quote")
    rset.add_argument("rate")

    report = sub.add_parser("report")
    report.add_argument("--currency", required=True)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    store = JsonStore.load(args.store)
    try:
        if args.entity == "customer" and args.action == "add":
            customer = core.create_customer(store, args.name, args.email)
            print(json.dumps({"id": customer.id, "name": customer.name, "email": customer.email}))
        elif args.entity == "invoice" and args.action == "create":
            invoice = core.create_invoice(store, args.customer_id, args.issued, args.due, args.item, args.tax, currency=args.currency)
            print(json.dumps(_invoice_row(invoice)))
        elif args.entity == "invoice" and args.action == "list":
            for invoice in core.list_invoices(store, args.customer):
                print(json.dumps(_invoice_row(invoice)))
        elif args.entity == "rate" and args.action == "set":
            core.set_rate(store, args.base, args.quote, args.rate)
            print(json.dumps({"base": args.base, "quote": args.quote, "rate": args.rate}))
        elif args.entity == "report":
            total = core.report_totals(store, args.currency)
            print(json.dumps({"currency": total.currency, "total": str(total.amount)}))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    JsonStore.save(store, args.store)
    return 0
