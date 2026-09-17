# 需求：收款与部分结清

给 invoicely 加收款记录，发票状态随之变化。

- 模型新增 `Payment(id, invoice_id, amount, paid_on)`；存储要持久化 payments。
- `invoicely.core`：
  - `record_payment(store, invoice_id, amount, paid_on) -> Payment`：`amount <= 0` 或超过剩余余额时抛 `ValueError`；发票不存在也抛 `ValueError`。
  - `invoice_balance(store, invoice_id) -> float`：总额减去已收款，保留两位小数。
  - `invoice_status(store, invoice_id) -> str`：没有收款是 `"open"`，部分收款是 `"partial"`，余额为 0 是 `"paid"`；`record_payment` 后 `Invoice.status` 字段也要同步。
- 命令行：新增 `payment add INVOICE_ID AMOUNT --on YYYY-MM-DD`，输出 JSON 一行（含 `id`、`invoice_id`、`amount`、`paid_on`）；`invoice list` 的每行增加 `balance` 与最新的 `status`。

风险中等，影响接口。请切成两个工作包：core（`invoicely/core.py`、`invoicely/models.py`、`invoicely/store.py` 与它们的测试）和 cli（`invoicely/cli.py` 与它的测试），cli 依赖 core，cli 包需要评审。
