#!/usr/bin/env python3
"""shell script（*.sh）で `$名前` の直後に ASCII 以外の文字が続く形を検出する（#159）。

macOS の bash（ja_JP.UTF-8）は `$BASE（` の全角括弧の先頭バイトを変数名の一部と読み、`BASE\\xef: unbound variable` で止まる。
Linux（glibc）では起きないので、子のコンテナの self-test では見逃す。`${名前}` で囲む。コメント行は対象外。
使い方: check-var-ascii.py <root>（root 直下の scripts/ と tests/ を再帰で見る）。該当があれば行を出して exit 1。
"""
import re
import sys
from pathlib import Path

PATTERN = re.compile(r"\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]")
root = Path(sys.argv[1])
found = []
for base in ("scripts", "tests"):
    for path in sorted((root / base).rglob("*.sh")):
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            if not line.lstrip().startswith("#") and PATTERN.search(line):
                found.append(f"{path.relative_to(root)}:{number}: {line.strip()[:100]}")
print("\n".join(found))
sys.exit(1 if found else 0)
