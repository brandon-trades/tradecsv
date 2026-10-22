# Writes examples/okx/okx-unified-bill-sample.csv: a SYNTHETIC file with the same structure as a real
# OKX "统一交易账单" export (Chinese interface) — metadata first line, a byte-order mark at the start of every line,
# only the first line ending is CRLF (the rest are LF, as in the real export), newest rows first. All ids, prices and amounts are invented; the user id is zeros.
# Balance columns are filled so that the identity seen in the real export holds:
#   交易账户余额变动 = −仓位余额变动 + 收益 + 手续费
# Run: python scripts/make-okx-sample.py
from decimal import Decimal as D
import os

BOM = "\ufeff"
HEADER = "id,关联订单id,时间,账单类型,交易品种,交易类型,数量,交易单位,成交价,收益,手续费,手续费单位,仓位余额变动,仓位余额,交易账户余额变动,交易账户余额,交易账户余额单位"
# (id, order, time UTC+8, bill type, instrument, trade type, qty, price, pnl, fee, position change)  — oldest first
ROWS = [
    ("1000000000000000001", "2000000000000000001", "2026-03-05 10:00:01", "永续合约", "BTC-USDT-SWAP", "开多", "2", "60000.0", "0", "-0.06", "12"),
    ("1000000000000000002", "2000000000000000001", "2026-03-05 10:00:01", "永续合约", "BTC-USDT-SWAP", "开多", "3", "60010.0", "0", "-0.090015", "18.003"),
    ("1000000000000000003", "2000000000000000002", "2026-03-05 18:30:00", "永续合约", "BTC-USDT-SWAP", "平多", "5", "60500.0", "2.497", "-0.15125", "-30.003"),
    ("1000000000000000004", "2000000000000000003", "2026-03-06 09:15:00", "永续合约", "ETH-USDT-SWAP", "开空", "10", "3000.00", "0", "-0.015", "6"),
    ("1000000000000000005", "", "2026-03-06 16:00:00", "永续合约", "ETH-USDT-SWAP", "资金费收入", "10", "3001.5", "0.0012", "0", "0"),
    ("1000000000000000006", "2000000000000000004", "2026-03-06 21:45:30", "永续合约", "ETH-USDT-SWAP", "平空", "10", "2990.00", "0.1", "-0.01495", "-6"),
    ("1000000000000000007", "", "2026-03-07 08:00:00", "划转", "", "转入", "50", "0", "0", "0", "0"),
]
fmt = lambda x: f"{D(x):.8f}"
balance = D("100")
position = {}
lines = []
for (i, o, t, bt, inst, tt, q, px, pnl, fee, pchg) in ROWS:
    pchg, pnl_d, fee_d = D(pchg), D(pnl), D(fee)
    change = -pchg + pnl_d + fee_d
    if tt == "转入":
        change = D(q)  # a transfer in: the amount arrives in the trading account
    balance += change
    position[inst] = position.get(inst, D(0)) + pchg
    lines.append([i, o, t, bt, inst, tt, q, "张", fmt(px), fmt(pnl), fmt(fee), "USDT", fmt(pchg), fmt(position[inst]), fmt(change), fmt(balance), "USDT"])
out = [f"{BOM}用户ID:0000000000000000000,{BOM}账户类型:Main,{BOM}时区:UTC+8", BOM + HEADER]
out += [BOM + ",".join(l) for l in reversed(lines)]  # newest first, like the real export
os.makedirs("examples/okx", exist_ok=True)
with open("examples/okx/okx-unified-bill-sample.csv", "w", encoding="utf-8", newline="") as f:
    # Like the real export: only the first (metadata) line ends with CRLF; every other line ends with LF
    f.write(BOM + out[0] + "\r\n" + "\n".join(out[1:]) + "\n")
print("wrote examples/okx/okx-unified-bill-sample.csv")
