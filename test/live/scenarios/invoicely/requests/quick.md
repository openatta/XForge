# 需求：逾期标记

给 invoicely 加逾期判断。

- `invoicely.core` 新增 `is_overdue(invoice, today) -> bool`：到期日早于 `today` 且状态不是 `"paid"` 时为真。
- `list_invoices(store, customer_id=None, overdue_as_of=None)`：给了 `overdue_as_of`（一个 `date`）就只返回截至该日已逾期的发票。
- 命令行 `invoice list` 新增 `--overdue`，可选 `--today YYYY-MM-DD`（缺省为今天）。

风险低，只动 `invoicely/` 与 `tests/`。接口基线要记这两处新增。
