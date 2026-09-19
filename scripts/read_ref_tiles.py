#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把「一张牌面参考图」读成可写进 SVG 的规格。

用途：手上只有一张栅格参考图（麻将牌面表、图标表、UI 截图）时，靠肉眼估色估位
一定会偏差。本脚本做三件事，全部是像素级测量：

  1. 网格定位  —— 用浅灰分框线找出每张牌的 bbox（不用手填坐标）
  2. 配色采样  —— 先**腐蚀一次**（只保留四邻同色系的像素 = 色块/笔画的内部），
                  再对 8 级量化后的颜色取众数。
                  别用「最饱和 5% 像素」：那会被混色暗边带偏，也会被更粗的元素带偏 ——
                  实测同一张参考图上，万字用的是偏紫的 #251665，而筒点是 #34486c，
                  两者根本不是同一个色；用最饱和法会把它们混成一个。
  3. 元素测量  —— 连通域分析，逐元素输出 bbox / 中心 / 尺寸 / 色系，
                  直接就能换算成 viewBox 坐标。

用法：
    python scripts/read_ref_tiles.py 参考图.png                 # 网格 + 配色 + 全部牌
    python scripts/read_ref_tiles.py 参考图.png --row 1         # 只看第 1 行（0 基）
    python scripts/read_ref_tiles.py 参考图.png --cells 0-4     # 只看第 0..4 张

依赖：Pillow（本机 managed venv 已带）。
"""
import argparse
import colorsys
import io
import os
import statistics
import sys
from collections import Counter, deque

from PIL import Image

# 色系判定：色相区间 → 名字（按需改这里）
HUES = [
    ('green', 95, 170),
    ('navy', 190, 268),
    ('red', 338, 360),
    ('red', 0, 20),
    ('orange', 20, 48),
    ('purple', 268, 338),
]
MIN_SAT = 0.42      # 低于此饱和度视为灰/白，不参与配色
MIN_CHROMA = 50     # max-min 通道差下限，滤掉抗锯齿灰边


def family(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    if mx - mn < MIN_CHROMA or mx < 45:
        return None
    h, s, v = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    h *= 360
    if s < MIN_SAT:
        return None
    for name, lo, hi in HUES:
        if lo <= h <= hi:
            return name
    return None


def detect_grid(im):
    """用浅灰分框线找行/列。返回 (xs, ys)，相邻两个值之间就是一张牌。"""
    W, H = im.size
    px = im.load()

    def is_line(r, g, b):
        mx, mn = max(r, g, b), min(r, g, b)
        return mx - mn < 16 and 170 <= mx <= 240

    colp, rowp = [0] * W, [0] * H
    for y in range(H):
        for x in range(W):
            if is_line(*px[x, y]):
                colp[x] += 1
                rowp[y] += 1

    def peaks(arr, thr):
        out, st = [], None
        for i, v in enumerate(arr):
            if v >= thr and st is None:
                st = i
            elif v < thr and st is not None:
                out.append((st + i - 1) // 2)
                st = None
        return out

    xs = peaks(colp, H * 0.45)
    ys = peaks(rowp, W * 0.35)
    # 相邻很近的两条线是同一根框线的两沿，合并
    def merge(a, gap=12):
        out = []
        for v in a:
            if out and v - out[-1] <= gap:
                out[-1] = (out[-1] + v) // 2
            else:
                out.append(v)
        return out
    return merge(xs), merge(ys)


def measure(im, box):
    """连通域分析：返回该牌内每个图形元素的 (bbox, 中心, 色系)。"""
    x0, y0, x1, y1 = box
    W, H = x1 - x0, y1 - y0
    x0, y0 = x0 + 2, y0 + 2               # 躲开框线本身
    W, H = W - 3, H - 3
    lab = [[family(*im.getpixel((x0 + x, y0 + y))) for x in range(W)] for y in range(H)]
    seen = [[False] * W for _ in range(H)]
    out = []
    for y in range(H):
        for x in range(W):
            if not lab[y][x] or seen[y][x]:
                continue
            q, pts = deque([(x, y)]), []
            seen[y][x] = True
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, -1), (1, -1), (-1, 1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < W and 0 <= ny < H and lab[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if len(pts) < 25:              # 噪点
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            col = Counter(lab[b][a] for a, b in pts).most_common(1)[0][0]
            out.append(((min(xs), min(ys), max(xs), max(ys)), col, len(pts)))
    out.sort(key=lambda t: (t[0][1] // 12, t[0][0]))
    return out, W, H


def sample_palette(im, y0=None, y1=None, topn=3):
    """腐蚀后取量化众数。返回 {色系: [(颜色, 占比), ...]}。

    y0/y1 可只统计某一行牌（放大镜下的牌面元素比字形笔画细得多，
    混在一起统计会被字形带偏）。
    """
    W, H = im.size
    px = im.load()
    y0 = 1 if y0 is None else max(1, y0)
    y1 = H - 1 if y1 is None else min(H - 1, y1)
    lab = [[family(*px[x, y]) for x in range(W)] for y in range(y0 - 1, y1 + 1)]
    cnt = {}
    for yy in range(1, len(lab) - 1):
        for x in range(1, W - 1):
            k = lab[yy][x]
            if not k:
                continue
            if lab[yy - 1][x] and lab[yy + 1][x] and lab[yy][x - 1] and lab[yy][x + 1]:
                cnt.setdefault(k, Counter())[px[x, y0 + yy - 1]] += 1
    out = {}
    for k, c in cnt.items():
        # 参考图有压缩噪点，同一个色会散成好几个近似值 → 先按 8 级量化合并再取众数
        merged = Counter()
        for (r, g, b), n in c.items():
            merged[(r // 8 * 8 + 4, g // 8 * 8 + 4, b // 8 * 8 + 4)] += n
        tot = sum(merged.values()) or 1
        out[k] = [(col, n / tot) for col, n in merged.most_common(topn)]
    return out


def contrast(c1, c2=(250, 246, 234)):
    def lum(c):
        def f(v):
            v /= 255.0
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
    a, b = lum(c1), lum(c2)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image')
    ap.add_argument('--row', type=int, help='只分析某一行（0 基）')
    ap.add_argument('--cells', help='只分析某几张牌，如 0-4 或 0,2,5（跨行连续编号）')
    ap.add_argument('--tile', help='牌框尺寸覆盖，如 84x105（默认自动推）')
    args = ap.parse_args()

    im = Image.open(args.image).convert('RGB')
    xs, ys = detect_grid(im)
    print('图 %dx%d' % im.size)
    print('竖线 x =', xs)
    print('横线 y =', ys)
    if len(xs) < 2 or len(ys) < 2:
        sys.exit('没能自动定位网格：请先用 --tile 或检查图上的分框线是否太浅')

    boxes = []
    for r in range(len(ys) - 1):
        for c in range(len(xs) - 1):
            boxes.append((xs[c], ys[r], xs[c + 1], ys[r + 1]))
    per_row = len(xs) - 1
    print('共 %d 行 × %d 列 = %d 张\n' % (len(ys) - 1, per_row, len(boxes)))

    # 逐行统计配色：不同行可能根本不是同一套色（实测项目里万/字那一行的蓝偏紫，
    # 和筒点/条竹的蓝差得很远），混在一起统计会得到一个谁都不像的中间值。
    print('配色（腐蚀后量化众数，对米白牌面 #faf6ea 的对比度）：')
    rowbands = [(ys[r], ys[r + 1]) for r in range(len(ys) - 1)]
    for r, (ry0, ry1) in enumerate(rowbands):
        if args.row is not None and r != args.row:
            continue
        pal = sample_palette(im, ry0 + 1, ry1 - 1)
        if not pal:
            print('  第%d行: （纯色像素不足，元素笔画太细，只能靠邻近行推断）' % r)
            continue
        print('  第%d行: ' % r + '   '.join(
            '%s #%02x%02x%02x %.2f:1 (%.0f%%)' % (k, v[0][0][0], v[0][0][1], v[0][0][2],
                                                  contrast(v[0][0]), v[0][1] * 100)
            for k, v in sorted(pal.items())))
    print()

    sel = list(range(len(boxes)))
    if args.row is not None:
        sel = list(range(args.row * per_row, (args.row + 1) * per_row))
    if args.cells:
        sel = []
        for part in args.cells.split(','):
            if '-' in part:
                a, b = part.split('-')
                sel += list(range(int(a), int(b) + 1))
            else:
                sel.append(int(part))

    for i in sel:
        box = boxes[i]
        els, W, H = measure(im, box)
        print('--- #%d 行%d列%d  frame=%dx%d  n=%d' % (i, i // per_row, i % per_row, W, H, len(els)))
        for (bx0, by0, bx1, by1), col, n in els:
            cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
            print('    %-5s box=(%3d,%3d)-(%3d,%3d) %2dx%2d  center=(%5.1f,%5.1f)'
                  '  换算 viewBox=(%5.1f,%5.1f) 尺寸=(%.1f,%.1f)'
                  % (col, bx0, by0, bx1, by1, bx1 - bx0 + 1, by1 - by0 + 1, cx, cy,
                     cx / W * 100, cy / H * 138, (bx1 - bx0 + 1) / W * 100, (by1 - by0 + 1) / H * 138))
        print()


if __name__ == '__main__':
    main()
