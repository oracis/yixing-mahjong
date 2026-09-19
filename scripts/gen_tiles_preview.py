import re, io, os

_HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(_HERE, '..', 'index.html')
OUT = os.path.join(_HERE, '..', 'tiles-preview.html')

html = io.open(SRC, encoding='utf-8').read()

start = html.index('const CONFIG = (function(){')
tail = '  return { faceHTML };\n})();'
end = html.index(tail) + len(tail)
modules = html[start:end]

# 只取「第一个」:root —— 这是全局根变量块。
# 后面几处 :root 都嵌在 @media 断点里（手机/窄屏覆盖值），
# 合并进来会把移动端尺寸带到预览页，桌面档位就被覆盖了。
roots = re.findall(r':root\{([\s\S]*?)\}', html)
if not roots:
    raise SystemExit('index.html 里找不到 :root 块')
ROOT = roots[0]

BASE_VARS = ['--tile-w', '--tile-h', '--small-w', '--small-h', '--mini-w', '--mini-h']
missing = [v for v in BASE_VARS if v not in ROOT]
if missing:
    raise SystemExit('第一个 :root（全局块）缺少尺寸变量: %s\n'
                     '预览页会因此渲染不出牌面，请把变量放回第一个 :root 块。' % ', '.join(missing))

TILE_CSS = re.search(r'(  \.tile\{[\s\S]*?\.tile\.mini \.face\{ padding:1px; \})', html).group(1)
if not TILE_CSS:
    raise SystemExit('抽不到 .tile 规则，选择器可能被改过')

TILES = (
    [('m', r) for r in range(1, 10)] +
    [('p', r) for r in range(1, 10)] +
    [('s', r) for r in range(1, 10)] +
    [('z', r) for r in range(1, 8)] +
    [('f', r) for r in range(1, 9)]
)
TILE_JS = '[' + ','.join('"%s%d"' % (s, r) for s, r in TILES) + ']'

doc = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>牌面预览 · 宜兴麻将</title>
<style>
  :root{%(root)s}
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{height:100%%;}
  body{
    background:radial-gradient(ellipse at 50%% 30%%, var(--felt) 0%%, var(--felt2) 100%%);
    color:#eee; padding:24px;
    font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  }
  h1{ font-size:20px; color:var(--gold); letter-spacing:2px; margin-bottom:4px; }
  h2{ font-size:14px; color:#a8c3b5; font-weight:400; margin:22px 0 10px; }
  .row{ display:flex; flex-wrap:wrap; gap:8px; }
%(tilecss)s
  .mini-row{ gap:5px; align-items:flex-end; }
</style>
</head>
<body>
  <h1>牌面预览</h1>
  <div style="font-size:12px;color:#9db8ab;margin-bottom:6px">共 %(n)d 种牌面，全部由 index.html 内的 TileArt 模块实时生成</div>

  <h2>标准尺寸 42×58（手牌）</h2>
  <div class="row" id="row-normal"></div>

  <h2>弃牌 / 副露尺寸 26×36（游戏内实际大小，桌面端）</h2>
  <div class="row mini-row" id="row-discard"></div>

  <h2>小尺寸 22×30（.tile.mini 基准档）</h2>
  <div class="row mini-row" id="row-mini"></div>

  <h2>同比例放大 84×116</h2>
  <div class="row" id="row-big"></div>

<script>
%(modules)s

var TILES = %(tilesjs)s;

function fill(id, cls, style){
  var box = document.getElementById(id);
  TILES.forEach(function(t){
    var el = document.createElement('div');
    el.className = 'tile ' + (TileUtils.isFlower(t)?'f':TileUtils.isHonor(t)?'z':t[0]) + ' ' + cls;
    if (style) el.setAttribute('style', style);
    el.innerHTML = '<div class="face">' + TileArt.faceHTML(t) + '</div>';
    box.appendChild(el);
  });
}
fill('row-normal', '');
fill('row-discard', 'mini', 'width:26px;height:36px');
fill('row-mini', 'mini');
fill('row-big', '', 'width:84px;height:116px');
</script>
</body>
</html>
""" % {'root': ROOT, 'tilecss': TILE_CSS, 'modules': modules,
       'tilesjs': TILE_JS, 'n': len(TILES)}

io.open(OUT, 'w', encoding='utf-8').write(doc)
print('written', OUT, len(doc), 'chars')
