from __future__ import annotations

from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Iterable, List, Optional

from .models import Customer, Invoice, LineItem, Money
from .store import Store

TWO_PLACES = Decimal("0.01")


def _q(value: Decimal) -> Decimal:
    return value.quantize(TWO_PLACES, rounding=ROUND_HALF_UP)


def create_customer(store: Store, name: str, email: str) -> Customer:
    if not name.strip():
        raise ValueError("customer name is required")
    if any(c.email == email for c in store.customers.values()):
        raise ValueError(f"email already registered: {email}")
    customer = Customer(id=store.next_id("CUS"), name=name.strip(), email=email)
    store.customers[customer.id] = customer
    return customer


def create_invoice(store: Store, customer_id: str, issued_on: date, due_on: date, items: Iterable[LineItem], tax_rate: float = 0.0, currency: str = "USD") -> Invoice:
    if customer_id not in store.customers:
        raise ValueError(f"unknown customer: {customer_id}")
    items = list(items)
    if not items:
        raise ValueError("an invoice needs at least one line item")
    if due_on < issued_on:
        raise ValueError("due_on must not be before issued_on")
    invoice = Invoice(id=store.next_id("INV"), customer_id=customer_id, issued_on=issued_on, due_on=due_on, items=items, tax_rate=tax_rate, currency=currency)
    store.invoices[invoice.id] = invoice
    return invoice


def invoice_total(invoice: Invoice) -> Money:
    subtotal = sum((Decimal(str(item.unit_price)) * item.quantity for item in invoice.items), Decimal("0"))
    return Money(_q(subtotal * (Decimal("1") + Decimal(str(invoice.tax_rate)))), invoice.currency)


def list_invoices(store: Store, customer_id: Optional[str] = None) -> List[Invoice]:
    invoices = sorted(store.invoices.values(), key=lambda i: i.id)
    if customer_id is not None:
        invoices = [i for i in invoices if i.customer_id == customer_id]
    return invoices


def set_rate(store: Store, base: str, quote: str, rate) -> None:
    rate = Decimal(str(rate))
    if rate <= 0:
        raise ValueError("rate must be positive")
    store.rates[(base, quote)] = rate


def convert(store: Store, money: Money, to_currency: str) -> Money:
    if money.currency == to_currency:
        return money
    rate = store.rates.get((money.currency, to_currency))
    if rate is None:
        raise ValueError(f"no rate from {money.currency} to {to_currency}")
    return Money(_q(money.amount * rate), to_currency)


def report_totals(store: Store, currency: str) -> Money:
    total = Decimal("0")
    for invoice in list_invoices(store):
        total += convert(store, invoice_total(invoice), currency).amount
    return Money(_q(total), currency)
