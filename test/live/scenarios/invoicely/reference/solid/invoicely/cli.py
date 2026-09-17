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


def _invoice_row(invoice, store=None) -> dict:
    row = {
        "id": invoice.id,
        "customer_id": invoice.customer_id,
        "issued_on": invoice.issued_on.isoformat(),
        "due_on": invoice.due_on.isoformat(),
        "total": core.invoice_total(invoice),
        "status": invoice.status,
    }
    if store is not None:
        row["balance"] = core.invoice_balance(store, invoice.id)
        row["status"] = core.invoice_status(store, invoice.id)
    return row


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="invoicely")
    parser.add_argument("--store", default="invoicely.json", help="path of the JSON store")
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
    create.add_argument("--item", type=_parse_item, action="append", required=True)
    listing = invoice.add_parser("list")
    listing.add_argument("--customer")

    payment = sub.add_parser("payment").add_subparsers(dest="action", required=True)
    pay = payment.add_parser("add")
    pay.add_argument("invoice_id")
    pay.add_argument("amount", type=float)
    pay.add_argument("--on", type=date.fromisoformat, required=True)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    store = JsonStore.load(args.store)
    try:
        if args.entity == "customer" and args.action == "add":
            customer = core.create_customer(store, args.name, args.email)
            print(json.dumps({"id": customer.id, "name": customer.name, "email": customer.email}))
        elif args.entity == "invoice" and args.action == "create":
            invoice = core.create_invoice(store, args.customer_id, args.issued, args.due, args.item, args.tax)
            print(json.dumps(_invoice_row(invoice)))
        elif args.entity == "invoice" and args.action == "list":
            for invoice in core.list_invoices(store, args.customer):
                print(json.dumps(_invoice_row(invoice, store)))
        elif args.entity == "payment" and args.action == "add":
            payment = core.record_payment(store, args.invoice_id, args.amount, args.on)
            print(json.dumps({"id": payment.id, "invoice_id": payment.invoice_id, "amount": payment.amount, "paid_on": payment.paid_on.isoformat()}))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    JsonStore.save(store, args.store)
    return 0
