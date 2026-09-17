# invoicely

一个只用 Python 标准库的小型开票工具：客户、发票（行项、税率）、JSON 文件存储、命令行。

```
python3 -m invoicely --store demo.json customer add "Ada" ada@example.com
python3 -m invoicely --store demo.json invoice create CUS-0001 --issued 2026-01-01 --due 2026-01-31 --tax 0.2 --item "hours:2:50"
python3 -m invoicely --store demo.json invoice list
python3 -m unittest discover -s tests
```
