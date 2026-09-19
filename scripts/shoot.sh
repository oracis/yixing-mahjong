#!/usr/bin/env bash
# 手机端排版截图（零依赖，用本机 Chrome 无头模式）
#
# 两个必须知道的坑：
# ① 不要用 --window-size 直接定设备宽度：Windows 无头 Chrome 会把视口钳到
#    最小 ~504 宽，请求 390 实际得到 504，截图右侧被裁掉 —— 看起来像
#    「南家不见了」，其实是截图假象。这里改成页面内放一个**精确尺寸的 iframe**，
#    iframe 视口 = 设备尺寸，外面等比缩放以便整屏入镜。
# ② 不要在 node 里 spawn Chrome（本机沙箱下 EBUSY），一律从 bash 调。
#
# 用法：
#   bash scripts/shoot.sh                 # 全部设备，#auto&fill=20
#   bash scripts/shoot.sh 390x844         # 只截指定尺寸
#   HASH='' bash scripts/shoot.sh         # 截开始页（不加 hash）
# 输出：.shots/<w>x<h>.png
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash 的 pwd 给的是 /c/... —— 直接拼 file:/// 会 ERR_FILE_NOT_FOUND，
# 必须用 pwd -W 拿 Windows 形式（C:/...）才能给 Chrome 用。
ROOTW="$(cd "$(dirname "$0")/.." && pwd -W)"
SHOTS="$ROOT/.shots"
HARNESS="$SHOTS/_harness.html"
HASH="${HASH-#auto&fill=20}"
mkdir -p "$SHOTS"

CHROME=""
for c in "/c/Program Files/Google/Chrome/Application/chrome.exe" \
         "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"; do
  [ -x "$c" ] && CHROME="$c" && break
done
[ -z "$CHROME" ] && { echo "找不到 Chrome/Edge"; exit 1; }

ALL="360x640 390x844 412x915 430x932 844x390 667x375 768x1024"
LIST="${1:-$ALL}"

shoot_one() {
  local w="$1" h="$2"
  # 无头视口上限（实测宽 ~504 / 高 ~750），留余量
  local s
  s=$(awk -v w="$w" -v h="$h" 'BEGIN{s=1; if(500/w<s)s=500/w; if(740/h<s)s=740/h; printf "%.4f", s}')
  local ow oh
  ow=$(awk -v w="$w" -v s="$s" 'BEGIN{printf "%d", w*s+1}')
  oh=$(awk -v h="$h" -v s="$s" 'BEGIN{printf "%d", h*s+1}')

  cat > "$HARNESS" <<EOF
<!DOCTYPE html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#0b0f0d;overflow:hidden}
#d{width:${ow}px;height:${oh}px;overflow:hidden}
iframe{border:0;display:block;width:${w}px;height:${h}px;transform:scale(${s});transform-origin:top left}</style>
<div id="d"><iframe src="../index.html${HASH}"></iframe></div>
EOF

  "$CHROME" --headless=new --disable-gpu --no-sandbox --hide-scrollbars \
    --force-device-scale-factor=1 --virtual-time-budget=6000 \
    --window-size="$ow,$oh" \
    --screenshot="$SHOTS/$w"x"$h.png" \
    "file:///$ROOTW/.shots/_harness.html$HASH" >/dev/null 2>&1
  if [ -f "$SHOTS/$w"x"$h.png" ]; then
    echo "  ${w}x${h}  scale=$s  -> .shots/${w}x${h}.png ($(( $(wc -c < "$SHOTS/$w"x"$h.png") / 1024 ))KB)"
  else
    echo "  ${w}x${h}  失败"
  fi
}

echo "截图（hash='$HASH'）："
for d in $LIST; do shoot_one "${d%x*}" "${d#*x}"; done
