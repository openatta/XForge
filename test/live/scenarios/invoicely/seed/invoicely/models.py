from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import List


@dataclass
class Customer:
    id: str
    name: str
    email: str


@dataclass
class LineItem:
    description: str
    quantity: int
    unit_price: float


@dataclass
class Invoice:
    id: str
    customer_id: str
    issued_on: date
    due_on: date
    items: List[LineItem] = field(default_factory=list)
    tax_rate: float = 0.0
    status: str = "open"
