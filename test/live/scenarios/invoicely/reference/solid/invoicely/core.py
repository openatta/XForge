from __future__ import annotations

from datetime import date
from typing import Iterable, List, Optional

from .models import Customer, Invoice, LineItem, Payment
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


def invoice_balance(store: Store, invoice_id: str) -> float:
    invoice = _invoice(store, invoice_id)
    paid = sum(p.amount for p in store.payments.values() if p.invoice_id == invoice_id)
    return round(invoice_total(invoice) - paid, 2)


def invoice_status(store: Store, invoice_id: str) -> str:
    invoice = _invoice(store, invoice_id)
    paid = sum(p.amount for p in store.payments.values() if p.invoice_id == invoice_id)
    if paid <= 0:
        return "open"
    return "paid" if round(invoice_total(invoice) - paid, 2) <= 0 else "partial"


def record_payment(store: Store, invoice_id: str, amount: float, paid_on: date) -> Payment:
    invoice = _invoice(store, invoice_id)
    if amount <= 0:
        raise ValueError("payment amount must be positive")
    if amount > invoice_balance(store, invoice_id) + 1e-9:
        raise ValueError("payment exceeds the outstanding balance")
    payment = Payment(id=store.next_id("PAY"), invoice_id=invoice_id, amount=round(amount, 2), paid_on=paid_on)
    store.payments[payment.id] = payment
    invoice.status = invoice_status(store, invoice_id)
    return payment


def _invoice(store: Store, invoice_id: str) -> Invoice:
    try:
        return store.invoices[invoice_id]
    except KeyError:
        raise ValueError(f"unknown invoice: {invoice_id}") from None
