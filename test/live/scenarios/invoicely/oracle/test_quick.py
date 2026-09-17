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
from invoicely.store import Store


class OverdueOracle(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.c = core.create_customer(self.store, "Ada", "ada@example.com")
        self.due_jan = core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 1, 10.0)])
        self.due_mar = core.create_invoice(self.store, self.c.id, date(2026, 1, 1), date(2026, 3, 31), [LineItem("y", 1, 10.0)])

    def test_is_overdue_uses_due_date_and_status(self):
        self.assertTrue(core.is_overdue(self.due_jan, date(2026, 2, 1)))
        self.assertFalse(core.is_overdue(self.due_jan, date(2026, 1, 31)))
        self.due_jan.status = "paid"
        self.assertFalse(core.is_overdue(self.due_jan, date(2026, 2, 1)))

    def test_list_filters_overdue_as_of(self):
        ids = [i.id for i in core.list_invoices(self.store, overdue_as_of=date(2026, 2, 15))]
        self.assertEqual(ids, [self.due_jan.id])
        self.assertEqual(len(core.list_invoices(self.store)), 2)

    def test_partial_status_is_still_overdue_and_customer_filter_composes(self):
        # 需求：状态不是 "paid" 就算逾期 —— partial / open 都算；customer_id 与 overdue_as_of 同时给要同时满足。
        self.due_jan.status = "partial"
        self.assertTrue(core.is_overdue(self.due_jan, date(2026, 2, 1)))
        other = core.create_customer(self.store, "Bob", "bob@example.com")
        core.create_invoice(self.store, other.id, date(2026, 1, 1), date(2026, 1, 15), [LineItem("z", 1, 5.0)])
        mine = [i.id for i in core.list_invoices(self.store, customer_id=self.c.id, overdue_as_of=date(2026, 2, 15))]
        self.assertEqual(mine, [self.due_jan.id])
        self.assertEqual(len(core.list_invoices(self.store, overdue_as_of=date(2026, 2, 15))), 2)
        # 截至日期早于所有到期日：一张都不逾期。
        self.assertEqual(core.list_invoices(self.store, overdue_as_of=date(2025, 12, 31)), [])

    def test_cli_overdue_defaults_to_today_and_rejects_bad_date(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, cid, inv = seeded_store(tmp)  # 到期 2026-01-31：相对真实的今天已逾期
            run(store, "invoice", "create", cid, "--issued", "2026-01-01", "--due", "2999-01-01", "--item", "far:1:1")
            out = run(store, "invoice", "list", "--overdue")
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual([json.loads(l)["id"] for l in out.stdout.splitlines()], [inv])
            bad = run(store, "invoice", "list", "--overdue", "--today", "not-a-date")
            self.assertNotEqual(bad.returncode, 0)

    def test_cli_overdue_flag_with_today(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, cid, inv = seeded_store(tmp)
            run(store, "invoice", "create", cid, "--issued", "2026-01-01", "--due", "2027-01-01", "--item", "later:1:1")
            out = run(store, "invoice", "list", "--overdue", "--today", "2026-06-01")
            self.assertEqual(out.returncode, 0, out.stderr)
            rows = [json.loads(l) for l in out.stdout.splitlines()]
            self.assertEqual([r["id"] for r in rows], [inv])


if __name__ == "__main__":
    unittest.main()
