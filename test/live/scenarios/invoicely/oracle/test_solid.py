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


from invoicely import core
from invoicely.models import LineItem
from invoicely.store import JsonStore, Store


class PaymentsOracle(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        c = core.create_customer(self.store, "Ada", "ada@example.com")
        self.inv = core.create_invoice(self.store, c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 2, 50.0)], tax_rate=0.2)  # 120.00

    def test_status_transitions_and_balance(self):
        self.assertEqual(core.invoice_status(self.store, self.inv.id), "open")
        self.assertEqual(core.invoice_balance(self.store, self.inv.id), 120.0)
        p = core.record_payment(self.store, self.inv.id, 20.0, date(2026, 1, 10))
        self.assertEqual(p.invoice_id, self.inv.id)
        self.assertEqual(core.invoice_status(self.store, self.inv.id), "partial")
        self.assertEqual(self.inv.status, "partial")
        self.assertEqual(core.invoice_balance(self.store, self.inv.id), 100.0)
        core.record_payment(self.store, self.inv.id, 100.0, date(2026, 1, 20))
        self.assertEqual(core.invoice_status(self.store, self.inv.id), "paid")
        self.assertEqual(self.inv.status, "paid")
        self.assertEqual(core.invoice_balance(self.store, self.inv.id), 0.0)

    def test_rejects_bad_amounts_and_unknown_invoice(self):
        with self.assertRaises(ValueError):
            core.record_payment(self.store, self.inv.id, 0, date(2026, 1, 10))
        with self.assertRaises(ValueError):
            core.record_payment(self.store, self.inv.id, 120.01, date(2026, 1, 10))
        with self.assertRaises(ValueError):
            core.record_payment(self.store, "INV-9999", 1.0, date(2026, 1, 10))

    def test_payments_survive_the_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.json")
            core.record_payment(self.store, self.inv.id, 20.0, date(2026, 1, 10))
            JsonStore.save(self.store, path)
            again = JsonStore.load(path)
            self.assertEqual(core.invoice_balance(again, self.inv.id), 100.0)
            self.assertEqual(core.invoice_status(again, self.inv.id), "partial")

    def test_exact_balance_pays_off_and_a_paid_invoice_takes_no_more(self):
        core.record_payment(self.store, self.inv.id, 120.0, date(2026, 1, 10))
        self.assertEqual(core.invoice_status(self.store, self.inv.id), "paid")
        self.assertEqual(core.invoice_balance(self.store, self.inv.id), 0.0)
        with self.assertRaises(ValueError):  # 余额为 0，任何金额都超过剩余余额
            core.record_payment(self.store, self.inv.id, 0.01, date(2026, 1, 11))
        with self.assertRaises(ValueError):
            core.record_payment(self.store, self.inv.id, -5.0, date(2026, 1, 11))

    def test_balance_keeps_two_decimals_and_payment_ids_are_unique(self):
        c = core.create_customer(self.store, "Bob", "bob@example.com")
        inv = core.create_invoice(self.store, c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 3, 33.333)])  # 99.999 → 100.00
        p1 = core.record_payment(self.store, inv.id, 0.1, date(2026, 1, 2))
        p2 = core.record_payment(self.store, inv.id, 0.2, date(2026, 1, 3))
        self.assertNotEqual(p1.id, p2.id)
        self.assertEqual(core.invoice_balance(self.store, inv.id), round(core.invoice_total(inv) - 0.3, 2))
        self.assertEqual(core.invoice_status(self.store, inv.id), "partial")
        # 每张发票各自记账：另一张不受影响。
        self.assertEqual(core.invoice_status(self.store, self.inv.id), "open")

    def test_cli_rejects_unknown_invoice_and_reports_paid_after_full_payment(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, cid, inv = seeded_store(tmp)  # 120.00
            self.assertEqual(run(store, "payment", "add", "INV-9999", "1", "--on", "2026-01-10").returncode, 2)
            self.assertEqual(run(store, "payment", "add", inv, "120", "--on", "2026-01-10").returncode, 0)
            listed = [json.loads(l) for l in run(store, "invoice", "list").stdout.splitlines()]
            self.assertEqual((listed[0]["balance"], listed[0]["status"]), (0.0, "paid"))
            self.assertEqual(run(store, "payment", "add", inv, "1", "--on", "2026-01-11").returncode, 2)

    def test_cli_payment_add_and_list_columns(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, cid, inv = seeded_store(tmp)
            paid = run(store, "payment", "add", inv, "70", "--on", "2026-01-10")
            self.assertEqual(paid.returncode, 0, paid.stderr)
            row = json.loads(paid.stdout)
            self.assertEqual((row["invoice_id"], row["amount"], row["paid_on"]), (inv, 70.0, "2026-01-10"))
            listed = [json.loads(l) for l in run(store, "invoice", "list").stdout.splitlines()]
            self.assertEqual((listed[0]["balance"], listed[0]["status"]), (50.0, "partial"))
            over = run(store, "payment", "add", inv, "999", "--on", "2026-01-11")
            self.assertEqual(over.returncode, 2)


if __name__ == "__main__":
    unittest.main()
