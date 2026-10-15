// node docs/images/logo/build-logo.mjs で logo.svg を作り直す（issue #414）。
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 行 0〜2 は大文字の上部、3〜7 は x ハイト、8〜10 は下に伸びる部分。
const ROWS = 11;
const GLYPHS = [
  { top: 0, rows: ["...##", "...##", "...##", "...##", "...##", "##.##", "##.##", "#####"] },
  { top: 0, rows: ["#####", "##.##", "##.##", "#####", "##...", "##...", "##...", "##..."] },
  { top: 3, rows: ["#####", "...##", "#####", "##.##", "#####"] },
  { top: 3, rows: ["#####", "##.##", "##.##", "##.##", "#####", "##...", "##...", "##..."] },
  { top: 3, rows: ["#####", "##.##", "#####", "##...", "#####"] },
  { top: 3, rows: ["#####", "##.##", "##...", "##...", "##..."] },
];
const CELL_W = 30;
const CELL_H = 30;
const SLANT = 0.547;
const COLOR = "#3caaa1";
const OUTLINE = "#d47735";
const OUTLINE_WIDTH = 8;
const MARGIN = 8 + OUTLINE_WIDTH / 2;

const height = ROWS * CELL_H;
// 字間は水平方向に縁 1 本分。
const GAP = OUTLINE_WIDTH;
let shift = 0;
const pt = ([x, y]) => `${(x * CELL_W + shift + SLANT * (height - y * CELL_H) + MARGIN).toFixed(1)} ${(y * CELL_H + MARGIN).toFixed(1)}`;

// 塗るマスの集まりの輪郭（マスの辺のうち 1 回だけ現れるもの）をつないだ閉路。
function outline(cells) {
  const filled = new Set(cells.map(([x, y]) => `${x},${y}`));
  const has = (x, y) => filled.has(`${x},${y}`);
  const next = new Map();
  const add = (a, b) => {
    const key = `${a[0]},${a[1]}`;
    if (next.has(key)) throw new Error(`斜めにだけ接するマスは描けない: ${key}`);
    next.set(key, b);
  };
  for (const [x, y] of cells) {
    if (!has(x, y - 1)) add([x, y], [x + 1, y]);
    if (!has(x + 1, y)) add([x + 1, y], [x + 1, y + 1]);
    if (!has(x, y + 1)) add([x + 1, y + 1], [x, y + 1]);
    if (!has(x - 1, y)) add([x, y + 1], [x, y]);
  }
  const loops = [];
  while (next.size > 0) {
    const [startKey, first] = next.entries().next().value;
    next.delete(startKey);
    const loop = [startKey.split(",").map(Number)];
    let cur = first;
    while (`${cur[0]},${cur[1]}` !== startKey) {
      loop.push(cur);
      const key = `${cur[0]},${cur[1]}`;
      const n = next.get(key);
      next.delete(key);
      cur = n;
    }
    loops.push(loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length];
      const b = loop[(i + 1) % loop.length];
      return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
    }));
  }
  return loops.map((l) => `M${l.map(pt).join("L")}Z`).join("");
}

const paths = [];
let left = 0;
for (const g of GLYPHS) {
  const cells = [];
  g.rows.forEach((line, i) => {
    [...line].forEach((c, k) => {
      if (c === "#") cells.push([left + k, g.top + i]);
    });
  });
  paths.push(`  <path d="${outline(cells)}"/>`);
  left += g.rows[0].length;
  shift += GAP;
}
const cols = left;
shift -= GAP;

const w = Math.ceil(cols * CELL_W + shift + SLANT * height + 2 * MARGIN);
const h = Math.ceil(height + 2 * MARGIN);
export const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="JPaper">
  <title>JPaper</title>
  <g fill="${COLOR}" fill-rule="evenodd" stroke="${OUTLINE}" stroke-width="${OUTLINE_WIDTH}" stroke-linejoin="miter" paint-order="stroke">
${paths.join("\n")}
  </g>
</svg>
`;
export const SVG_PATH = fileURLToPath(new URL("./logo.svg", import.meta.url));

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(SVG_PATH, svg);
