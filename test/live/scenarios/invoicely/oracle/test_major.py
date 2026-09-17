import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import date


def run(store, *args):
    env = dict(os.environ, PYTHONPATH=os.getcwd())
    return subprocess.run([sys.executable, "-m", "invoicely", "--store", store, *args], capture_output=True, text=True, env=env)


def seeded_store(tmp):
    store = os.path.join(tmp, "s.json")
    cid = json.loads(run(store, "customer", "add", "Ada", "ada@example.com").stdout)["id"]
    inv = json.loads(run(store, "invoice", "create", cid, "--issued", "2026-01-01", "--due", "2026-01-31", "--tax", "0.2", "--item", "hours:2:50").stdout)["id"]
    return store, cid, inv

from decimal import Decimal

from invoicely import core
from invoicely.models import LineItem, Money
from invoicely.store import JsonStore, Store

# 需求只说「新增 migrate_store(path)」，没有定模块：core、store、migration 任一处都算。
migrate_store = None
for _mod in ("invoicely.core", "invoicely.store", "invoicely.migration"):
    try:
        migrate_store = getattr(__import__(_mod, fromlist=["migrate_store"]), "migrate_store")
        break
    except (ImportError, AttributeError):
        continue
assert migrate_store is not None, "migrate_store 在 invoicely.core / store / migration 里都没有"


class MultiCurrencyOracle(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.c = core.create_customer(self.store, "Ada", "ada@example.com")

    def test_invoice_total_is_money_rounded_half_up(self):
        inv = core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 3, 0.335)], currency="EUR")
        total = core.invoice_total(inv)
        self.assertIsInstance(total, Money)
        self.assertEqual((total.amount, total.currency), (Decimal("1.01"), "EUR"))

    def test_convert_and_report(self):
        core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 1, 100.0)], currency="USD")
        core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("y", 1, 10.0)], currency="EUR")
        core.set_rate(self.store, "EUR", "USD", Decimal("1.10"))  # 需求没定 rate 的类型；黑盒用 Decimal，不赌实现会转换字符串
        self.assertEqual(core.convert(self.store, Money(Decimal("10.00"), "EUR"), "USD"), Money(Decimal("11.00"), "USD"))
        self.assertEqual(core.convert(self.store, Money(Decimal("5"), "USD"), "USD"), Money(Decimal("5"), "USD"))
        self.assertEqual(core.report_totals(self.store, "USD"), Money(Decimal("111.00"), "USD"))
        with self.assertRaises(ValueError):
            core.convert(self.store, Money(Decimal("1"), "USD"), "JPY")

    def test_legacy_store_migrates_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "old.json")
            with open(path, "w") as f:
                json.dump({"customers": [{"id": "CUS-0001", "name": "Ada", "email": "a@e.com"}],
                           "invoices": [{"id": "INV-0001", "customer_id": "CUS-0001", "issued_on": "2026-01-01", "due_on": "2026-01-31",
                                         "items": [{"description": "x", "quantity": 1, "unit_price": 10.0}], "tax_rate": 0.0, "status": "open"}],
                           "counters": {"CUS": 1, "INV": 1}}, f)
            loaded = JsonStore.load(path)
            self.assertEqual(core.invoice_total(loaded.invoices["INV-0001"]).currency, "USD")
            migrate_store(path)
            with open(path) as f:
                first = f.read()
            self.assertEqual(json.loads(first)["invoices"][0]["currency"], "USD")
            migrate_store(path)
            with open(path) as f:
                self.assertEqual(f.read(), first)  # 可重复执行：第二次不改文件

    def test_rounding_is_half_up_and_tax_applies_to_money(self):
        inv = core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 1, 2.345)], currency="USD")
        self.assertEqual(core.invoice_total(inv).amount, Decimal("2.35"))  # ROUND_HALF_UP，不是银行家舍入的 2.34
        taxed = core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("y", 1, 10.0)], tax_rate=0.175, currency="USD")
        self.assertEqual(core.invoice_total(taxed), Money(Decimal("11.75"), "USD"))

    def test_only_direct_rates_convert_and_rates_persist(self):
        core.set_rate(self.store, "EUR", "USD", Decimal("1.10"))
        with self.assertRaises(ValueError):  # 需求：有直接汇率才换算；反向没登记就是没有
            core.convert(self.store, Money(Decimal("1"), "USD"), "EUR")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.json")
            JsonStore.save(self.store, path)
            again = JsonStore.load(path)
            self.assertEqual(core.convert(again, Money(Decimal("2.00"), "EUR"), "USD"), Money(Decimal("2.20"), "USD"))

    def test_report_mixes_currencies_and_fails_without_a_rate(self):
        core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 1, 100.0)], currency="USD")
        core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("y", 1, 10.0)], currency="GBP")
        with self.assertRaises(ValueError):
            core.report_totals(self.store, "USD")
        core.set_rate(self.store, "GBP", "USD", Decimal("1.25"))
        self.assertEqual(core.report_totals(self.store, "USD"), Money(Decimal("112.50"), "USD"))

    def test_cli_rate_and_report(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, cid, inv = seeded_store(tmp)  # 120.00 USD
            created = run(store, "invoice", "create", cid, "--issued", "2026-01-01", "--due", "2026-01-31", "--currency", "EUR", "--item", "y:1:10")
            self.assertEqual(created.returncode, 0, created.stderr)
            self.assertEqual(run(store, "rate", "set", "EUR", "USD", "2").returncode, 0)
            report = run(store, "report", "--currency", "USD")
            self.assertEqual(report.returncode, 0, report.stderr)
            self.assertEqual(json.loads(report.stdout), {"currency": "USD", "total": "140.00"})


if __name__ == "__main__":
    unittest.main()
