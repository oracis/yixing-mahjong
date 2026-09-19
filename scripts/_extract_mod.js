// 从 index.html 抽出 TileArt 等模块，供 node 直接 require 做几何校验
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'index.html');
const s = fs.readFileSync(src, 'utf8');
const start = s.indexOf('const CONFIG = (function(){');
const tail = '  return { faceHTML };\n})();';
const end = s.indexOf(tail);
if (start < 0 || end < 0) throw new Error('index.html 结构变了，找不到 CONFIG/TileArt 模块边界');
fs.writeFileSync(path.join(__dirname, '_mods.js'), s.slice(start, end + tail.length) + '\nmodule.exports={TileArt,CONFIG,TileUtils};\n');
console.log('extracted', end + tail.length - start, 'chars');
