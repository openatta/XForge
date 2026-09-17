from __future__ import annotations

from datetime import date
from typing import Iterable, List, Optional

from .models import Customer, Invoice, LineItem
from .store import Store


def create_customer(store: Store, name: str, email: str) -> Customer:
    if not name.strip():
        raise ValueError("customer name is required")
    if any(c.email == email for c in store.customers.values()):
        raise ValueError(f"email already registered: {email}")
    customer = Customer(id=store.next_id("CUS"), name=name.strip(), email=email)
    store.customers[customer.id] = customer
    return customer


def create_invoice(
    store: Store,
    customer_id: str,
    issued_on: date,
    due_on: date,
    items: Iterable[LineItem],
    tax_rate: float = 0.0,
) -> Invoice:
    if customer_id not in store.customers:
        raise ValueError(f"unknown customer: {customer_id}")
    items = list(items)
    if not items:
        raise ValueError("an invoice needs at least one line item")
    if due_on < issued_on:
        raise ValueError("due_on must not be before issued_on")
    invoice = Invoice(id=store.next_id("INV"), customer_id=customer_id, issued_on=issued_on, due_on=due_on, items=items, tax_rate=tax_rate)
    store.invoices[invoice.id] = invoice
    return invoice


def invoice_total(invoice: Invoice) -> float:
    subtotal = sum(item.quantity * item.unit_price for item in invoice.items)
    return round(subtotal * (1 + invoice.tax_rate), 2)


def list_invoices(store: Store, customer_id: Optional[str] = None) -> List[Invoice]:
    invoices = sorted(store.invoices.values(), key=lambda i: i.id)
    if customer_id is not None:
        invoices = [i for i in invoices if i.customer_id == customer_id]
    return invoices
