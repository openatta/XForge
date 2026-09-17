import unittest
from datetime import date

from invoicely import core
from invoicely.models import LineItem
from invoicely.store import Store


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.customer = core.create_customer(self.store, "Ada", "ada@example.com")

    def test_customer_email_must_be_unique(self):
        with self.assertRaises(ValueError):
            core.create_customer(self.store, "Other", "ada@example.com")

    def test_invoice_total_applies_tax_and_rounds(self):
        invoice = core.create_invoice(self.store, self.customer.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("hours", 3, 33.333)], tax_rate=0.1)
        self.assertEqual(core.invoice_total(invoice), 110.0)

    def test_invoice_needs_items_and_ordered_dates(self):
        with self.assertRaises(ValueError):
            core.create_invoice(self.store, self.customer.id, date(2026, 1, 1), date(2026, 1, 31), [])
        with self.assertRaises(ValueError):
            core.create_invoice(self.store, self.customer.id, date(2026, 1, 31), date(2026, 1, 1), [LineItem("x", 1, 1.0)])

    def test_list_filters_by_customer(self):
        other = core.create_customer(self.store, "Bob", "bob@example.com")
        core.create_invoice(self.store, self.customer.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("x", 1, 1.0)])
        core.create_invoice(self.store, other.id, date(2026, 1, 1), date(2026, 1, 31), [LineItem("y", 1, 1.0)])
        self.assertEqual([i.customer_id for i in core.list_invoices(self.store, other.id)], [other.id])
        self.assertEqual(len(core.list_invoices(self.store)), 2)


if __name__ == "__main__":
    unittest.main()
