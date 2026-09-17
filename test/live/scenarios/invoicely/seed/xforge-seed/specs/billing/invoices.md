# 发票

<!-- xforge:entries:begin kind=requirements -->
### Requirement: REQ-billing-invoices-001 · 发票至少一个行项且到期日不早于开票日
- **WHEN** 行项为空，或到期日早于开票日
- **THEN** 拒绝创建

### Requirement: REQ-billing-invoices-002 · 总额含税并四舍五入到分
- **WHEN** 计算发票总额
- **THEN** 行项金额之和乘以 (1 + 税率)，保留两位小数

### Requirement: REQ-billing-invoices-003 · 按客户列出发票
- **WHEN** 列出发票并指定客户
- **THEN** 只返回该客户的发票，按 id 排序
<!-- xforge:entries:end -->
