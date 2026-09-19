/* 手机端布局几何模拟（纯计算，不依赖浏览器）
 * 用途：把 CSS 里的尺寸变量 + Grid 规则翻译成数字，检查
 *   ① 手牌一行能否塞下 14 张且不溢出
 *   ② 中央牌河在竖屏/横屏下还剩多少高度给四家弃牌
 *   ③ 上下家那一列（信息条+副露+牌背+弃牌）会不会把牌河撑爆
 * 修改 index.html 的 :root / @media 后请重跑本脚本。
 */
const AR = 1.381;            // --tile-ar
const HAND_GAP = 3;          // --hand-gap

const DEFAULTS = {
  tileW: 42, miniW: 30, backW: 30, backStep: 19, sbackW: 24, sbackH: 9,
  handReserve: 51,           // (100vw - 51px)/14
  sideW: 104,                // --side-w：上下家那一列的固定宽度
};

function varsFor(w, h) {
  const v = { ...DEFAULTS };
  const landscape = w > h;
  // 与 CSS 同序：landscape(303) → max-width:620(317) → max-width:400(322)，后者覆盖前者
  if (landscape && h <= 600) {
    v.tileW = 38; v.miniW = 22; v.backStep = 17; v.sbackW = 22; v.sbackH = 8;
    v.handReserve = 110; v.sideW = 96; v.backW = 26;
  }
  if (w <= 620) { v.tileW = 34; v.miniW = 30; v.backStep = 17; v.sbackW = 22; v.sideW = 96; }
  if (w <= 380) { v.tileW = 30; v.miniW = 26; v.backStep = 15; v.sbackW = 19; v.sbackH = 8; v.sideW = 88; }
  // --ld-w：中央放大的最后一张弃牌
  v.ldW = w <= 380 ? Math.min(48, w * 0.13) : w <= 620 ? Math.min(60, w * 0.17) : Math.min(64, w * 0.18);
  v.ldNeed = v.ldW * AR + 26 + 6;   // 牌高 + 标签一行 + 内边距
  v.handW = Math.min(v.tileW, (w - v.handReserve) / 14);
  v.handH = v.handW * AR;
  v.miniH = v.miniW * AR;
  v.backH = v.backW * AR;
  v.smallH = 30 * AR;        // --small-w 未被响应式改动
  v.landscape = landscape;
  return v;
}

// ---- 各区块高度估算（与 CSS 行高/padding 对齐）----
function blockHeights(v, opts) {
  const headH = (v.tileW <= 30 ? 11 : 12) * 1.2 + 4 + 2;   // .seat-head: font+padding+border
  const seatRowH = Math.max(headH, 18);                     // 花牌 chip 18px
  const northH = seatRowH + (opts.northMelds > 0 ? v.smallH + 3 : 0);
  const nbackH = v.backH;                                   // .backs-h 一排
  const actsH  = opts.acts ? 40 : 0;
  const handH  = seatRowH + 3 + v.handH;                    // #area-south
  return { headH, seatRowH, northH, nbackH, actsH, handH };
}

function simulate(w, h, opts = {}) {
  const o = { northMelds: 0, acts: true, discards: 20, safeTop: 0, safeBottom: 0, ...opts };
  const v = varsFor(w, h);
  const topbar = (v.landscape && h <= 600) ? 34 : 44;
  const gap = (v.landscape && h <= 600) ? 3 : 4;

  const tableH = h - topbar - o.safeTop;
  const innerH = tableH - 4 - (6 + o.safeBottom);
  const innerW = w - 12;

  const b = blockHeights(v, o);
  const riverH = innerH - b.northH - b.nbackH - b.actsH - b.handH - 4 * gap;

  // #river 内部：side-w | 1fr | side-w + 2×3px gap
  const riverW = innerW;
  const colSide = Math.min(v.sideW, (riverW - 6) / 3);
  const colC = riverW - 2 * colSide - 6;

  // #river.tight：后期自动缩一档（倍率，且横屏不缩）
  if (o.discards > 22 && h > 600) { v.miniW *= 0.78; v.miniH = v.miniW * AR; }

  const miniPitch = v.miniW + 2;
  const perRowC = Math.max(1, Math.floor((colC + 2) / miniPitch));
  const rowsFull = Math.ceil(o.discards / perRowC);
  const rnH = rowsFull * v.miniH + (rowsFull - 1) * 2;
  /* 竖屏：两条带按内容长，富余全给中央格（中央只有一句提示，多出来的算留白）。
     横屏矮屏：中央格压到 0，两条带平分高度 —— 高度本来就紧，留白是奢侈品。 */
  const split = v.landscape && h <= 600;
  const centerH = split ? 0 : riverH - rnH * 2 - 2 * 3;
  // 中央内容：最后一张弃牌（大牌 + 「谁打出」标签）+ 提示语
  const bandH = split ? (riverH - 2 * 3) / 2 : rnH;

  // 上下家竖列：弃牌横躺（.rv 占位 mini-h 宽 × mini-w 高），按列排
  const perColSide = Math.max(1, Math.floor((colSide - 6 + 2) / (v.miniH + 2)));
  const rowsSideNeeded = Math.ceil(o.discards / perColSide);
  const sideDiscH = rowsSideNeeded * v.miniW + (rowsSideNeeded - 1) * 2;
  const headMiniH = 26;                                     // 折两行
  const backsVH = 13 * v.sbackH + 12 * 2;                   // 13 张薄片
  const sideNeed = headMiniH + sideDiscH + backsVH + 3 * 2; // + melds 忽略（副露时才占）
  // 侧列能露出来的「最近弃牌」张数：牌背先塌，剩下的高度给弃牌（flex-end → 保留最新的）
  const sideRoom = Math.max(0, riverH - headMiniH - 8);
  const sideVisible = Math.floor(sideRoom / (v.miniW + 2)) * perColSide;

  return {
    v, w, h, topbar, riverH, innerW,
    handW: +v.handW.toFixed(1), handH: +v.handH.toFixed(1),
    handRowW: +(14 * v.handW + 13 * HAND_GAP).toFixed(1),
    availHandW: innerW,
    colC: +colC.toFixed(1), colSide: +colSide.toFixed(1),
    perRowC, rnH: +rnH.toFixed(1),
    sideDiscH: +sideDiscH.toFixed(1), sideNeed: +sideNeed.toFixed(1),
    sideVisible, sideTotal: Math.min(o.discards, sideVisible),
    centerH: +centerH.toFixed(1), bandH: +bandH.toFixed(1),
    sideRoom: +sideRoom.toFixed(1),
    northH: +b.northH.toFixed(1), nbackH: +b.nbackH.toFixed(1),
    actsH: b.actsH, handBlockH: +b.handH.toFixed(1),
  };
}

const CASES = [
  ['iPhone SE 竖',        375, 667],
  ['iPhone 12/13 竖',     390, 844],
  ['iPhone 14PM 竖',      430, 932],
  ['Android 中端 竖',     412, 915],
  ['小屏 竖',             360, 640],
  ['iPhone 14PM 竖+安全区', 430, 932, { safeTop: 47, safeBottom: 34 }],
  ['iPhone 12 横',        844, 390],
  ['iPhone SE 横',        667, 375],
  ['iPad 竖',             768, 1024],
  ['桌面',                1280, 800],
  // 后期压力：每家 26 张弃牌（牌墙快摸完时的极限）
  ['iPhone 12/13 竖 后期', 390, 844, { discards: 26 }],
  ['iPhone SE 横 后期',    667, 375, { discards: 26 }],
];

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('视口', 22), pad('手牌/张', 9), pad('弃牌/张', 9), pad('带内容H', 8),
            pad('带可用H', 8), pad('中央余', 8), pad('中央需', 7), pad('侧列可见', 9), pad('牌河H', 7), '判定');
let bad = 0;
for (const [name, w, h, opts] of CASES) {
  const r = simulate(w, h, opts);
  const split = r.v.landscape && h <= 600;
  const handOK = r.handRowW <= r.availHandW + 0.5;
  // 竖屏看「中央留白是否放得下提示」，横屏看「一条带是否装得下自己的弃牌」
  const riverOK = split ? r.rnH <= r.bandH + 0.5 : r.centerH >= r.v.ldNeed;
  const sideOK = r.sideTotal >= 8;                  // 侧列至少露出最近 8 张（横屏物理上限）
  const ok = handOK && riverOK && sideOK;
  if (!ok) bad++;
  console.log(
    pad(name, 22),
    pad(r.handW + '×' + r.handH, 9),
    pad(r.v.miniW.toFixed(0) + '×' + (r.v.miniW * AR).toFixed(0), 9),
    pad(r.rnH, 8),
    pad(r.bandH.toFixed(0) + (split ? ' *' : ''), 8),
    pad(split ? '-' : r.centerH.toFixed(0), 8),
    pad(split ? '-' : r.v.ldNeed.toFixed(0), 7),
    pad(r.sideTotal + '/' + (opts?.discards ?? 20), 9),
    pad(r.riverH.toFixed(0), 7),
    (handOK ? '' : '手牌溢出! ') + (riverOK ? '' : (split ? '弃牌带装不下! ' : '中央不够! ')) + (sideOK ? '' : '侧列可见不足! ') + (ok ? 'OK' : '')
  );
}
console.log(bad === 0 ? '\n全部视口通过' : `\n${bad} 个视口不通过`);
process.exit(bad === 0 ? 0 : 1);
