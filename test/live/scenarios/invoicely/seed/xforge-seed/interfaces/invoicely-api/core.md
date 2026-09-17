# core

<!-- xforge:entries:begin kind=elements -->
### Element: fn:create_customer · 创建客户
summary: (store, name, email) -> Customer
### Element: fn:create_invoice · 创建发票
summary: (store, customer_id, issued_on, due_on, items, tax_rate=0.0) -> Invoice
### Element: fn:invoice_total · 发票总额
summary: (invoice) -> float
### Element: fn:list_invoices · 列出发票
summary: (store, customer_id=None) -> list[Invoice]
<!-- xforge:entries:end -->
