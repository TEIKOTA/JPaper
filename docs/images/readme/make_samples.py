"""README の見本の画像を、対訳 PDF の決まったページから切り出す（issue #368）。

使い方: python3 docs/images/readme/make_samples.py <MaRS の対訳 PDF>
  例: python3 docs/images/readme/make_samples.py article/2606.22649-ja/2606.22649_mars-bilingual.pdf
必要なもの: poppler の pdftocairo、Pillow
"""
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parent
DPI = 110
# (出力名, ページ, 切り出す縦の範囲（ページの高さに対する割合）)
CROPS = [
    ("mars-p2-fig1.png", 2, (0.04, 0.62)),
    ("mars-p5-fig2.png", 5, (0.04, 0.40)),
]


def main(pdf: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        for name, page, (top, bottom) in CROPS:
            base = Path(tmp) / f"p{page}"
            subprocess.run(
                ["pdftocairo", "-png", "-r", str(DPI), "-f", str(page), "-l", str(page), "-singlefile", pdf, str(base)],
                check=True,
            )
            im = Image.open(f"{base}.png")
            w, h = im.size
            im.crop((0, int(h * top), w, int(h * bottom))).save(OUT / name, optimize=True)
            print(OUT / name)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
