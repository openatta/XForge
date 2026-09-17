# 需求：多币种与存量数据迁移

invoicely 要支持多币种发票与汇率换算，并迁移已有的存储文件。

- 模型新增 `Money(amount: Decimal, currency: str)`（`invoicely.models`）。`Invoice` 新增 `currency` 字段；`create_invoice(..., currency="USD")`。
- `invoice_total(invoice)` 改为返回 `Money`（这是破坏性变更，旧调用方拿到的不再是 float）。金额用 `Decimal`，保留两位小数，舍入方式 `ROUND_HALF_UP`。
- `invoicely.core` 新增：
  - `set_rate(store, base, quote, rate)`：登记 1 `base` = `rate` `quote`；存储持久化汇率表。
  - `convert(store, money, to_currency) -> Money`：同币种原样返回；有直接汇率就换算；没有则抛 `ValueError`。
  - `report_totals(store, currency) -> Money`：全部发票总额换算到 `currency` 后求和。
- 存量数据：旧的存储文件里发票没有 `currency`，读取时视为基准币种 `"USD"`；新增 `migrate_store(path)` 把文件改写成带 `currency` 的新形状，且可重复执行。
- 命令行：`invoice create --currency`（缺省 USD）、`rate set BASE QUOTE RATE`、`report --currency CUR`（输出一行 JSON：`{"currency": ..., "total": "..."}`，`total` 是两位小数的字符串）。

风险高，影响接口与存量数据。两个先要回答的问题：基准币种是什么（默认 USD）；舍入方式（默认 ROUND_HALF_UP 到两位）。工作包建议三个：core、migration、cli。
