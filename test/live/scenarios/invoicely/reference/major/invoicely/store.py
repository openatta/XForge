from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Dict, Tuple

from .models import Customer, Invoice, LineItem

BASE_CURRENCY = "USD"


class Store:
    def __init__(self) -> None:
        self.customers: Dict[str, Customer] = {}
        self.invoices: Dict[str, Invoice] = {}
        self.rates: Dict[Tuple[str, str], Decimal] = {}
        self._counters: Dict[str, int] = {}

    def next_id(self, prefix: str) -> str:
        n = self._counters.get(prefix, 0) + 1
        self._counters[prefix] = n
        return f"{prefix}-{n:04d}"

    def to_dict(self) -> dict:
        return {
            "version": 2,
            "customers": [asdict(c) for c in self.customers.values()],
            "invoices": [_invoice_to_dict(i) for i in self.invoices.values()],
            "rates": [{"base": b, "quote": q, "rate": str(r)} for (b, q), r in sorted(self.rates.items())],
            "counters": dict(self._counters),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Store":
        store = cls()
        for c in data.get("customers", []):
            store.customers[c["id"]] = Customer(**c)
        for i in data.get("invoices", []):
            store.invoices[i["id"]] = _invoice_from_dict(i)
        for r in data.get("rates", []):
            store.rates[(r["base"], r["quote"])] = Decimal(r["rate"])
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
        currency=d.get("currency", BASE_CURRENCY),
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


def migrate_store(path: str) -> int:
    """Rewrite a v1 file into the v2 shape (every invoice carries a currency). Idempotent. Returns invoices touched."""
    p = Path(path)
    data = json.loads(p.read_text())
    touched = 0
    for i in data.get("invoices", []):
        if "currency" not in i:
            i["currency"] = BASE_CURRENCY
            touched += 1
    data.setdefault("rates", [])
    data["version"] = 2
    p.write_text(json.dumps(data, indent=2, sort_keys=True))
    return touched
