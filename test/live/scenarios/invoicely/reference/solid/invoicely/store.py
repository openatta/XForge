from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from pathlib import Path
from typing import Dict

from .models import Customer, Invoice, LineItem, Payment


class Store:
    """In-memory state; JsonStore moves it to and from disk."""

    def __init__(self) -> None:
        self.customers: Dict[str, Customer] = {}
        self.invoices: Dict[str, Invoice] = {}
        self.payments: Dict[str, Payment] = {}
        self._counters: Dict[str, int] = {}

    def next_id(self, prefix: str) -> str:
        n = self._counters.get(prefix, 0) + 1
        self._counters[prefix] = n
        return f"{prefix}-{n:04d}"

    def to_dict(self) -> dict:
        return {
            "customers": [asdict(c) for c in self.customers.values()],
            "invoices": [_invoice_to_dict(i) for i in self.invoices.values()],
            "payments": [dict(asdict(p), paid_on=p.paid_on.isoformat()) for p in self.payments.values()],
            "counters": dict(self._counters),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Store":
        store = cls()
        for c in data.get("customers", []):
            store.customers[c["id"]] = Customer(**c)
        for i in data.get("invoices", []):
            store.invoices[i["id"]] = _invoice_from_dict(i)
        for p in data.get("payments", []):
            store.payments[p["id"]] = Payment(id=p["id"], invoice_id=p["invoice_id"], amount=float(p["amount"]), paid_on=date.fromisoformat(p["paid_on"]))
        store._counters = dict(data.get("counters", {}))
        return store


def _invoice_to_dict(invoice: Invoice) -> dict:
    d = asdict(invoice)
    d["issued_on"] = invoice.issued_on.isoformat()
    d["due_on"] = invoice.due_on.isoformat()
    return d


def _invoice_from_dict(d: dict) -> Invoice:
    return Invoice(
        id=d["id"],
        customer_id=d["customer_id"],
        issued_on=date.fromisoformat(d["issued_on"]),
        due_on=date.fromisoformat(d["due_on"]),
        items=[LineItem(**item) for item in d.get("items", [])],
        tax_rate=float(d.get("tax_rate", 0.0)),
        status=d.get("status", "open"),
    )


class JsonStore:
    @staticmethod
    def load(path: str) -> Store:
        p = Path(path)
        if not p.exists():
            return Store()
        return Store.from_dict(json.loads(p.read_text()))

    @staticmethod
    def save(store: Store, path: str) -> None:
        Path(path).write_text(json.dumps(store.to_dict(), indent=2, sort_keys=True))
