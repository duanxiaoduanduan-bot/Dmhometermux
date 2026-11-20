const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = process.env.FILE_PORT ? Number(process.env.FILE_PORT) : 8087;
const PAGE_DIR = __dirname;

// 快捷目录 / 自定义存储介质
const SHORTCUTS_PATH = path.join(PAGE_DIR, 'file-shortcuts.json');
const os = require('os');

// 安全检查：只禁止访问系统敏感目录，其余全部放行（含新增 U 盘/挂载点）
const FORBIDDEN = ['/proc', '/sys', '/dev'];

function isPathSafe(targetPath) {
  const rp = (() => { try { return fs.realpathSync(targetPath); } catch (_) { return path.resolve(targetPath); } })();
  // Windows 盘符路径放行
  if (/^[A-Za-z]:[\\/]/.test(rp) || /^[A-Za-z]:$/.test(rp)) return true;
  for (const fb of FORBIDDEN) {
    if (rp === fb || rp.startsWith(fb + path.sep)) return false;
  }
  return true;
}

function normalizeShortcut(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let p = String(entry.path || '').trim();
  if (!p) return null;
  // 历史兼容：path: "page" → 当前服务目录
  if (p === 'page' || p === '.' || p === './') p = PAGE_DIR;
  // 非 Windows 平台上，Windows 盘符路径（如 D:\xxx / C:\Users）是从物理机带来的残留：
  // path.resolve 会把它当相对路径拼到 PAGE_DIR 后变成废路径 → 直接拒绝，交给 autoDiscover 重建
  const isWindowsDrive = /^[A-Za-z]:[\\/]/.test(p) || /^[A-Za-z]:$/.test(p);
  if (isWindowsDrive && process.platform !== 'win32') return null;
  if (!path.isAbsolute(p) && !isWindowsDrive) {
    p = path.resolve(PAGE_DIR, p);
  }
  p = path.resolve(p);
  const name = String(entry.name || path.basename(p) || p).trim() || p;
  const type = entry.type === 'storage' || entry.kind === 'storage' ? 'storage' : (entry.type || 'shortcut');
  return { name, path: p, type };
}

function resolveShortcutPath(p) {
  const n = normalizeShortcut({ name: '', path: p });
  return n ? n.path : path.resolve(String(p || PAGE_DIR));
}

// 读取快捷目录
function loadShortcuts() {
  try {
    if (fs.existsSync(SHORTCUTS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(SHORTCUTS_PATH, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) {
        // 只保留真实存在且可读的目录：失效路径（尤其从物理机带来的 Windows 路径）丢弃
        const valid = saved.map(normalizeShortcut).filter(Boolean).filter(s => {
          try { fs.accessSync(s.path, fs.constants.R_OK); return fs.statSync(s.path).isDirectory(); }
          catch (_) { return false; }
        });
        if (valid.length > 0) return valid;
        // 全部失效 → 重新自动探测 termux 真实目录并覆盖
        return autoDiscover();
      }
    }
  } catch (_) {}
  return autoDiscover();
}

function autoDiscover() {
  const discovered = [];
  const candidates = [
    { name: '📁 当前目录', path: PAGE_DIR, type: 'shortcut' },
    { name: '🏠 用户目录', path: os.homedir(), type: 'shortcut' },
  ];

  // Termux（Android）环境：列出真实可访问的根，避免物理机路径水土不服
  const isTermux = (!!process.env.PREFIX && String(process.env.PREFIX).includes('com.termux')) || !!process.env.TERMUX_VERSION;
  let rootCandidates;
  if (isTermux) {
    rootCandidates = [];
    const home = os.homedir();
    if (home) rootCandidates.push({ name: '🏠 用户目录', path: home });
    const prefix = process.env.PREFIX;
    if (prefix) rootCandidates.push({ name: '📂 Termux 环境', path: prefix });
    rootCandidates.push({ name: '📱 /storage', path: '/storage' });
    rootCandidates.push({ name: '📱 内部存储', path: '/storage/emulated/0' }); // 需 termux-setup-storage 授权
  } else {
    // 物理机 / 容器：原路径
    rootCandidates = [
      { name: '📦 /workspace', path: '/workspace' },
      { name: '🏠 /home', path: '/home' },
      { name: '🔧 /root', path: '/root' },
      { name: '📱 /storage', path: '/storage' },
      { name: '💾 /mnt', path: '/mnt' },
      { name: '📀 /media', path: '/media' },
      { name: '💿 /run/media', path: '/run/media' },
      { name: '📂 /opt', path: '/opt' },
      { name: '📊 /var', path: '/var' },
      { name: '🗂️ /srv', path: '/srv' },
    ];
  }

  // Windows：把存在的盘符加入候选
  if (process.platform === 'win32') {
    for (let i = 67; i <= 90; i++) { // C-Z
      const letter = String.fromCharCode(i);
      const drive = letter + ':\\';
      try {
        if (fs.existsSync(drive)) {
          rootCandidates.push({
            name: (letter === 'C' ? '💻 ' : '💾 ') + letter + ':',
            path: drive,
            type: letter === 'C' ? 'shortcut' : 'storage',
          });
        }
      } catch (_) {}
    }
  }

  for (const c of candidates) {
    try { if (fs.existsSync(c.path)) discovered.push(normalizeShortcut(c)); } catch (_) {}
  }
  for (const c of rootCandidates) {
    if (discovered.find(d => d.path === path.resolve(c.path))) continue;
    try {
      if (fs.existsSync(c.path)) discovered.push(normalizeShortcut({ ...c, type: c.type || 'shortcut' }));
    } catch (_) {}
  }

  const cleaned = discovered.filter(Boolean);
  saveShortcuts(cleaned);
  return cleaned;
}

function saveShortcuts(data) {
  const list = (Array.isArray(data) ? data : []).map(normalizeShortcut).filter(Boolean);
  fs.writeFileSync(SHORTCUTS_PATH, JSON.stringify(list, null, 2), 'utf8');
  shortcuts = list;
  return list;
}

/** 新增一条存储介质 / 快捷目录（去重、校验可读） */
function addStorageEntry({ name, path: rawPath, type = 'storage' } = {}) {
  if (!rawPath || !String(rawPath).trim()) {
    return { ok: false, error: '请提供路径' };
  }
  const resolved = resolveShortcutPath(rawPath);
  if (!isPathSafe(resolved)) {
    return { ok: false, error: '禁止访问系统敏感目录' };
  }
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return { ok: false, error: '路径不是目录' };
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch (e) {
    return { ok: false, error: '目录不存在或不可读: ' + e.message };
  }

  // 盘符根目录 basename 可能为空，用 D: 这类标签
  let autoName = path.basename(resolved);
  if (!autoName || autoName === path.sep || /^[A-Za-z]:\\?$/.test(resolved)) {
    const m = String(resolved).match(/^([A-Za-z]:)/);
    autoName = m ? m[1] : resolved;
  }
  const entry = normalizeShortcut({
    name: (name && String(name).trim()) || ('💾 ' + autoName),
    path: resolved,
    type: type === 'shortcut' ? 'shortcut' : 'storage',
  });
  if (entry.type === 'storage' && !/^[💾💿📱💻]/.test(entry.name)) {
    entry.name = '💾 ' + entry.name.replace(/^💾\s*/, '');
  }

  const list = loadShortcuts().slice();
  const idx = list.findIndex(s => path.resolve(s.path) === entry.path);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...entry };
  } else {
    list.push(entry);
  }
  saveShortcuts(list);
  return { ok: true, entry, shortcuts: list };
}

let shortcuts = loadShortcuts();

// 获取父目录
function getParent(p) {
  const parent = path.dirname(p);
  if (!isPathSafe(parent)) return PAGE_DIR;
  return parent;
}

// 收集媒体库快捷入口（从 storage-config.json）—— 每次调用重新读，支持改配置后生效
function loadMediaPaths() {
  const configPath = path.join(PAGE_DIR, 'storage-config.json');
  const media = [];
  try {
    if (fs.existsSync(configPath)) {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const LABELS = {
        music: '🎵 音乐', video: '🎬 视频', tvdrama: '📺 电视剧',
        album: '🖼️ 写真馆', book: '📚 书籍', pdf: '📕 PDF',
        audio: '🎧 有声书', geodata: '🗺️ 地理数据',
      };
      for (const [key, entry] of Object.entries(cfg.paths || {})) {
        const resolved = path.isAbsolute(entry.dir) ? entry.dir : path.resolve(PAGE_DIR, entry.dir);
        try {
          if (fs.existsSync(resolved)) {
            media.push({ key, name: LABELS[key] || key, path: resolved, section: 'media' });
          }
        } catch (_) {}
      }
    }
  } catch (_) {}
  return media;
}

/** 扫描可挂载/外接存储（U 盘、移动硬盘、Windows 盘符等） */
function scanMounts() {
  const mounts = [];
  const seen = new Set();

  function pushMount(name, fullPath, source, extra = {}) {
    try {
      const resolved = path.resolve(fullPath);
      if (seen.has(resolved)) return;
      if (!isPathSafe(resolved)) return;
      if (!fs.existsSync(resolved)) return;
      const st = fs.statSync(resolved);
      if (!st.isDirectory()) return;
      fs.accessSync(resolved, fs.constants.R_OK);
      let count = 0;
      try { count = fs.readdirSync(resolved).length; } catch (_) { count = 0; }
      seen.add(resolved);
      mounts.push({
        name,
        path: resolved,
        source,
        size: count + ' 项',
        pinned: shortcuts.some(s => path.resolve(s.path) === resolved),
        ...extra,
      });
    } catch (_) {}
  }

  // Linux / 容器常见挂载根
  const scanRoots = ['/media', '/mnt', '/run/media', '/run/media/' + (process.env.USER || '')];
  for (const scanDir of scanRoots) {
    try {
      if (!fs.existsSync(scanDir)) continue;
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(scanDir, entry.name);
        // /run/media/user/DISK 再下一层
        if (scanDir === '/run/media' || scanDir.startsWith('/run/media/')) {
          try {
            const subs = fs.readdirSync(fullPath, { withFileTypes: true });
            const subDirs = subs.filter(s => s.isDirectory() && !s.name.startsWith('.'));
            if (subDirs.length > 0 && scanDir === '/run/media') {
              for (const s of subDirs) {
                pushMount('💿 ' + s.name, path.join(fullPath, s.name), fullPath);
              }
              continue;
            }
          } catch (_) {}
        }
        pushMount('💿 ' + entry.name, fullPath, scanDir);
      }
    } catch (_) {}
  }

  // Android / Termux
  try {
    if (fs.existsSync('/storage')) {
      for (const entry of fs.readdirSync('/storage', { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        if (entry.name === 'emulated' || entry.name === 'self') continue;
        pushMount('📱 ' + entry.name, path.join('/storage', entry.name), '/storage');
      }
    }
  } catch (_) {}

  // Windows 盘符（可移动盘优先标 storage）
  if (process.platform === 'win32') {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const drive = letter + ':\\';
      try {
        if (!fs.existsSync(drive)) continue;
        pushMount(
          (letter === 'C' ? '💻 ' : '💾 ') + letter + ':',
          drive,
          'win-drive',
          { drive: letter }
        );
      } catch (_) {}
    }
  }

  // 已固定为 storage 类型的快捷项也列出来（即使当前不在挂载扫描里）
  for (const s of shortcuts) {
    if (s.type === 'storage') {
      pushMount(s.name, s.path, 'pinned', { pinned: true });
    }
  }

  return { mounts, scanDirs: ['/media', '/mnt', '/run/media', '/storage', 'Windows 盘符 A-Z'] };
}

// === 启动端口服务时自动挂载数据盘（确保服务能读能写）===
// 用 lsblk 动态发现“未挂载的数据分区”，挂到 /run/media/duan/<盘名>：
//   - 不写死设备，换电脑/换盘通用；
//   - 已挂载的跳过，绝不重复挂载造成死循环；
//   - 不动系统根分区/交换分区（有挂载点或 fstype=swap 会被过滤）；
//   - 服务以 root 运行，挂载后 root 可读写；NTFS/exFAT 额外给 duan(uid1000) 读写权限；
//   - 不主动卸载任何盘，桌面自己挂的盘保持原样。
function getUnmountedDataPartitions() {
  try {
    const out = execSync('lsblk -J -o NAME,PATH,TYPE,FSTYPE,MOUNTPOINT,LABEL,UUID 2>/dev/null', { encoding: 'utf8' });
    const json = JSON.parse(out);
    const result = [];
    const walk = (nodes) => {
      for (const n of (nodes || [])) {
        if (n.type === 'part' && n.fstype && n.fstype !== 'swap') {
          if (!n.mountpoint) result.push({ dev: n.path, fstype: n.fstype, label: n.label || '', uuid: n.uuid || '' });
        }
        if (n.children) walk(n.children);
      }
    };
    walk(json.blockdevices);
    return result;
  } catch (e) { return []; }
}

function isAlreadyMounted(dev) {
  try {
    const mp = execSync(`findmnt -n -o TARGET ${dev} 2>/dev/null`).toString().trim();
    return !!mp;
  } catch (_) { return false; }
}

function mountDataDisks() {
  if (process.platform === 'win32') return; // Windows 盘符由 scanMounts 直接列，不需要 mount
  const parts = getUnmountedDataPartitions();
  for (const p of parts) {
    try {
      if (isAlreadyMounted(p.dev)) continue; // 已挂载则跳过，避免重复挂载死循环
      const safe = (p.label && /^[A-Za-z0-9_.\\-]+$/.test(p.label))
        ? p.label
        : (p.uuid || p.dev.replace(/[\\/\\\\]/g, '_'));
      const target = '/run/media/duan/' + safe;
      fs.mkdirSync(target, { recursive: true });
      let opts = 'defaults';
      if (p.fstype === 'ntfs' || p.fstype === 'ntfs-3g' || p.fstype === 'exfat') {
        opts = 'defaults,uid=1000,gid=1000,umask=022'; // NTFS/exFAT 让 duan 也能读写
      }
      execSync(`mount -t ${p.fstype} -o ${opts} ${p.dev} ${target} 2>&1`);
      console.log(`[mountDataDisks] mounted ${p.dev} (${p.fstype}) -> ${target}`);
    } catch (e) {
      console.warn(`[mountDataDisks] skip ${p.dev}: ${(e.message || '').split('\\n')[0]}`);
    }
  }
}

// ===== 完整性校验 / 打包核心（纯 Node，无外部命令依赖）=====
const UPLOAD_TMP = '.upload-part'; // 上传临时分片后缀，列表里隐藏

// 断点续传：记录本次进程用到过的上传目录（用于分片过期清理）
const UPLOAD_DIRS = new Set();

// 断点续传：分片 id 只允许安全字符，避免路径穿越
function safePartId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 72) || 'anon';
}
function partPathFor(dir, subDir, id) {
  return path.join(dir, subDir, '.' + safePartId(id) + '.' + UPLOAD_TMP);
}
// 流式算文件 SHA-256（续传收齐后对整文件校验用，不整包进内存）
function hashFile(fp) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(fp, { highWaterMark: 1024 * 1024 });
    rs.on('data', c => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}
// 定时清理超过 24 小时未完成的上传分片（前端中途放弃的残留）
function cleanupStaleParts() {
  let cleaned = 0;
  function walk(d) {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) walk(fp); continue; }
      if (!e.name.includes(UPLOAD_TMP)) continue;
      try {
        const st = fs.statSync(fp);
        if (Date.now() - st.mtimeMs > 24 * 3600 * 1000) { fs.unlinkSync(fp); cleaned++; }
      } catch (_) {}
    }
  }
  walk(PAGE_DIR);
  // 清理本次进程上传过的目录（含外接存储根）
  for (const d of UPLOAD_DIRS) { if (d !== PAGE_DIR) walk(d); }
  if (cleaned) console.log(`[cleanupStaleParts] removed ${cleaned} stale upload part(s)`);
}
setInterval(cleanupStaleParts, 3600 * 1000).unref?.();

// CRC32（ZIP 用），标准 IEEE 表
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
// 累积式更新（内部不 finalize），供流式分块调用
function crc32Update(crc, buf) {
  let c = crc;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return c >>> 0;
}
// 一次性计算完整 CRC（内部完成初值 + finalize）
function crc32(buf) { return (crc32Update(0xFFFFFFFF, buf) ^ 0xFFFFFFFF) >>> 0; }

// DOS 时间/日期（ZIP local header 用）
function dosDateTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/**
 * 流式打包多个文件为 ZIP（store 模式，不压缩，快且省内存；视频等本身已压缩）。
 * 每个文件先算 SHA-256 + size 写入 __MANIFEST.json，保证归档自带完整性清单。
 * 通过 res 流式输出，不整包进内存。
 */
function streamZip(files, res, archiveName) {
  // files: [{src, name}]  name = zip 内相对路径
  const entries = [];
  // 先探测每个文件大小并生成清单数据
  for (const f of files) {
    try {
      const st = fs.statSync(f.src);
      if (!st.isFile()) continue;
      entries.push({ ...f, size: st.size, mtime: st.mtime });
    } catch (_) {}
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    algorithm: 'sha256',
    note: '逐文件 sha256；下载后可用校验工具核对，或在本网盘用「校验」功能',
    files: [],
  };
  // 清单里先放占位，hash 在写流时算
  for (const e of entries) {
    manifest.files.push({ path: e.name, size: e.size, sha256: null });
  }

  const safeAscii = String(archiveName || 'files').replace(/[^\\x20-\\x7E]/g, '_').replace(/[\\/\\:*?"<>|]/g, '_') || 'files';
  const utfName = encodeURIComponent(archiveName || 'files');
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${safeAscii}.zip"; filename*=UTF-8''${utfName}.zip`,
    'Cache-Control': 'private, max-age=0',
  });

  const central = [];
  let offset = 0;
  let aborted = false;
  res.on('close', () => { aborted = true; });

  // 预计算每个文件的 crc + sha256（流式），再写头+数据，保证 local header 里的 crc/size 正确
  function inspectFile(src, cb) {
    const sha = crypto.createHash('sha256');
    let crc = 0xFFFFFFFF;
    let size = 0;
    const rs = fs.createReadStream(src, { highWaterMark: 1024 * 1024 });
    rs.on('data', chunk => { sha.update(chunk); crc = crc32Update(crc, chunk); size += chunk.length; });
    rs.on('error', () => cb(null));
    rs.on('end', () => cb({ size, crc: (crc ^ 0xFFFFFFFF) >>> 0, sha256: sha.digest('hex') }));
  }

  const all = entries.map(e => ({ ...e }));
  let idx = 0;
  function putNext() {
    if (aborted || idx >= all.length) return writeManifest();
    const e = all[idx++];
    inspectFile(e.src, info => {
      if (!info) return putNext();
      const nameBuf = Buffer.from(e.name, 'utf8');
      const flags = 0x0800;
      const { time, date } = dosDateTime(e.mtime);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034B50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(0, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(info.crc, 14);
      local.writeUInt32LE(info.size, 18);
      local.writeUInt32LE(info.size, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      const startOffset = offset;
      res.write(local);
      res.write(nameBuf);
      offset += 30 + nameBuf.length + info.size;
      // 更新清单 hash
      const mf = manifest.files.find(m => m.path === e.name);
      if (mf) mf.sha256 = info.sha256;
      // 写 central
      const centralRec = Buffer.alloc(46);
      centralRec.writeUInt32LE(0x02014B50, 0);
      centralRec.writeUInt16LE(20, 4);
      centralRec.writeUInt16LE(20, 6);
      centralRec.writeUInt16LE(flags, 8);
      centralRec.writeUInt16LE(0, 10);
      centralRec.writeUInt16LE(time, 12);
      centralRec.writeUInt16LE(date, 14);
      centralRec.writeUInt32LE(info.crc, 16);
      centralRec.writeUInt32LE(info.size, 20);
      centralRec.writeUInt32LE(info.size, 24);
      centralRec.writeUInt16LE(nameBuf.length, 28);
      centralRec.writeUInt16LE(0, 30);
      centralRec.writeUInt16LE(0, 32);
      centralRec.writeUInt16LE(0, 34);
      centralRec.writeUInt16LE(0, 36);
      centralRec.writeUInt32LE(0, 38);
      centralRec.writeUInt32LE(startOffset, 42);
      central.push(centralRec, nameBuf);
      // 流式输出文件内容
      const rs = fs.createReadStream(e.src, { highWaterMark: 1024 * 1024 });
      rs.on('data', chunk => { if (!aborted) res.write(chunk); });
      rs.on('error', () => {});
      rs.on('end', putNext);
    });
  }

  function writeManifest() {
    if (aborted) return;
    // 清单内容需要在 hash 都填好后重新生成
    const mfBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const nameBuf = Buffer.from('__MANIFEST.json', 'utf8');
    const flags = 0x0800;
    const { time, date } = dosDateTime();
    const crc = crc32(mfBuf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(mfBuf.length, 18);
    local.writeUInt32LE(mfBuf.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const startOffset = offset;
    res.write(local); res.write(nameBuf); res.write(mfBuf);
    offset += 30 + nameBuf.length + mfBuf.length;
    const centralRec = Buffer.alloc(46);
    centralRec.writeUInt32LE(0x02014B50, 0);
    centralRec.writeUInt16LE(20, 4);
    centralRec.writeUInt16LE(20, 6);
    centralRec.writeUInt16LE(flags, 8);
    centralRec.writeUInt16LE(0, 10);
    centralRec.writeUInt16LE(time, 12);
    centralRec.writeUInt16LE(date, 14);
    centralRec.writeUInt32LE(crc, 16);
    centralRec.writeUInt32LE(mfBuf.length, 20);
    centralRec.writeUInt32LE(mfBuf.length, 24);
    centralRec.writeUInt16LE(nameBuf.length, 28);
    centralRec.writeUInt16LE(0, 30);
    centralRec.writeUInt16LE(0, 32);
    centralRec.writeUInt16LE(0, 34);
    centralRec.writeUInt16LE(0, 36);
    centralRec.writeUInt32LE(0, 38);
    centralRec.writeUInt32LE(startOffset, 42);
    central.push(centralRec, nameBuf);

    const cdSize = central.reduce((s, b) => s + b.length, 0);
    // 记录数 = 实际写入的文件 + 清单本身（central 里每项是 46 字节记录 + 文件名）
    let count = 1; // manifest
    for (let i = 0; i < manifest.files.length; i++) if (manifest.files[i].sha256 != null) count++;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054B50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    for (const b of central) res.write(b);
    res.write(eocd);
    res.end();
  }

  putNext();
}

const MIME = {
  '.html':'text/html; charset=utf-8','.js':'application/javascript',
  '.css':'text/css','.json':'application/json',
  '.mp3':'audio/mpeg','.mp4':'video/mp4','.wav':'audio/wav','.flac':'audio/flac',
  '.ogg':'audio/ogg','.aac':'audio/aac','.m4a':'audio/mp4',
  '.webm':'video/webm','.mkv':'video/x-matroska','.mov':'video/quicktime',
  '.avi':'video/x-msvideo','.flv':'video/x-flv','.wmv':'video/x-ms-wmv',
  '.txt':'text/plain; charset=utf-8','.pdf':'application/pdf',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
  '.webp':'image/webp','.svg':'image/svg+xml','.bmp':'image/bmp',
  '.zip':'application/zip','.tar':'application/x-tar','.gz':'application/gzip',
  '.7z':'application/x-7z-compressed','.rar':'application/vnd.rar',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt':'application/vnd.ms-powerpoint','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.apk':'application/vnd.android.package-archive',
  '.exe':'application/x-msdownload','.msi':'application/x-msi',
  '.iso':'application/x-iso9660-image',
};

// 格式化文件大小
function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const reqPath = decodeURIComponent(url.pathname);
  const method = req.method;

  // CORS（含自定义文件名头，供流式上传）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, Content-Length');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Accept-Ranges, Content-Range');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // === API: 浏览目录 ===
  if (reqPath === '/api/list' && method === 'GET') {
    let browsePath = url.searchParams.get('path') || PAGE_DIR;
    browsePath = path.resolve(browsePath);
    
    if (!isPathSafe(browsePath)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '禁止访问系统目录' }));
    }

    try {
      const stat = fs.statSync(browsePath);
      if (!stat.isDirectory()) {
        // 如果是文件，返回其所在目录
        browsePath = path.dirname(browsePath);
      }

      const entries = fs.readdirSync(browsePath, { withFileTypes: true });
      const items = [];
      
      for (const e of entries) {
        // 隐藏上传中的临时分片（.xxx.upload-part[.随机后缀]）
        if (e.name.includes(UPLOAD_TMP)) continue;
        const fp = path.join(browsePath, e.name);
        try {
          const st = fs.statSync(fp);
          items.push({
            name: e.name,
            path: fp,
            isDir: e.isDirectory(),
            size: e.isDirectory() ? 0 : st.size,
            sizeFmt: e.isDirectory() ? '-' : fmtSize(st.size),
            mtime: st.mtime.toISOString(),
          });
        } catch (_) {}
      }

      // 排序：目录在前，文件在后，各自按名称排序
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name, 'zh');
      });

      const parent = getParent(browsePath);
      // 每次重新读 shortcuts / 媒体库，支持新增存储后立刻出现
      shortcuts = loadShortcuts();
      const userRoots = shortcuts.map(s => ({
        name: s.name,
        path: s.path,
        section: s.type === 'storage' ? 'storage' : 'shortcut',
        type: s.type || 'shortcut',
      }));
      const mediaRoots = loadMediaPaths();
      const roots = [...userRoots, ...mediaRoots];

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({
        current: browsePath,
        parent: parent !== browsePath ? parent : null,
        items,
        roots,
      }));
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '目录不存在: ' + e.message }));
    }
  }

  // === API: 下载文件（支持 Range，大文件可断点/边下边用）===
  // === 目录打包下载：优先 zip(UTF-8 文件名)，无 zip 则回退 tar.gz ===
  function streamDirAsArchive(dir, res, baseName) {
    const { spawnSync, spawn } = require('child_process');
    const safeAscii = String(baseName).replace(/[\\"\r\n]/g, '_').replace(/[^\x20-\x7E]/g, '_').replace(/_+/g, '_') || 'folder';
    const utfName = encodeURIComponent(baseName);
    const zipProbe = spawnSync('zip', ['--version'], { stdio: 'ignore' });
    let proc, contentType, fileExt;
    if (zipProbe.status === 0) {
      proc = spawn('zip', ['-r', '-', '-UN=UTF8', '.'], { cwd: dir });
      contentType = 'application/zip';
      fileExt = 'zip';
    } else {
      proc = spawn('tar', ['-czf', '-', '-C', dir, '.'], {});
      contentType = 'application/gzip';
      fileExt = 'tar.gz';
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${safeAscii}.${fileExt}"; filename*=UTF-8''${utfName}.${fileExt}`,
      'Cache-Control': 'private, max-age=0',
    });
    proc.stdout.pipe(res);
    proc.on('error', () => { if (!res.writableEnded) res.end(); });
    proc.on('close', () => { if (!res.writableEnded) res.end(); });
  }

  if (reqPath === '/api/download' && method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      return res.end('Missing path');
    }
    const resolved = path.resolve(filePath);
    if (!isPathSafe(resolved)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return streamDirAsArchive(resolved, res, path.basename(resolved) || 'folder');
      }
      const filename = path.basename(resolved);
      const ext = path.extname(filename).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const total = stat.size;
      // 中文名：filename= 只用 ASCII 兜底，真正名字放 filename*=UTF-8''（RFC 5987），避免下载乱码
      const safeAscii = filename
        .replace(/[\\"\r\n]/g, '_')
        .replace(/[^\x20-\x7E]/g, '_')
        .replace(/_+/g, '_') || 'download';
      const disposition = `attachment; filename="${safeAscii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
      const range = req.headers.range;

      if (range) {
        const m = String(range).match(/bytes=(\d*)-(\d*)/);
        if (!m) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          return res.end();
        }
        end = Math.min(end, total - 1);
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=0',
        });
        fs.createReadStream(resolved, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': disposition,
          'Content-Length': total,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=0',
        });
        fs.createReadStream(resolved, { highWaterMark: 1024 * 1024 }).pipe(res);
      }
    } catch (e) {
      res.writeHead(404);
      return res.end('File not found');
    }
    return;
  }

  // === API: 上传文件（优先原始二进制流，避免整文件进内存）===
  if (reqPath === '/api/upload' && method === 'POST') {
    const uploadDir = url.searchParams.get('dir') || PAGE_DIR;
    const resolved = path.resolve(uploadDir);
    if (!isPathSafe(resolved)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '上传目录不在允许范围内' }));
    }
    try { fs.mkdirSync(resolved, { recursive: true }); } catch (_) {}

    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/i);

    // 原始流：?name= 或 X-File-Name（推荐，边收边写，无损原文件）
    // 文件名约定：前端 encodeURIComponent，服务端 decode 一次，保留中文/空格等
    if (!boundaryMatch) {
      let filename = '';
      const headerName = req.headers['x-file-name'];
      if (headerName) {
        try { filename = decodeURIComponent(String(headerName)); } catch (_) { filename = String(headerName); }
      }
      if (!filename) {
        // URLSearchParams.get 已自动 decode 一层，勿再 decodeURIComponent（防二次解码把 % 弄坏）
        filename = url.searchParams.get('name') || '';
      }
      if (!filename) filename = 'upload.bin';
      // 支持相对路径子目录（文件夹上传保留层级），同时防路径穿越
      // 拆段 → 过滤非法段(. / ..) → 末段为文件名，其余为子目录
      const rawParts = String(filename).split(/[\\/]+/).filter(Boolean);
      const safeParts = rawParts.filter(p => p !== '.' && p !== '..');
      let finalBase = safeParts.length ? safeParts[safeParts.length - 1] : 'upload.bin';
      // 文件名非法字符清理（保留中文/空格，去掉 \ / : * ? " < > | 及控制字符）
      finalBase = finalBase.replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_');
      if (!finalBase || finalBase === '.' || finalBase === '..') finalBase = 'upload.bin';
      const subDir = safeParts.slice(0, -1).join(path.sep);
      fs.mkdirSync(path.join(resolved, subDir), { recursive: true });

      // 完整性校验：前端可带期望大小与 SHA-256
      let expectSize = null;
      if (req.headers['x-file-size'] != null && req.headers['x-file-size'] !== '') {
        const n = Number(req.headers['x-file-size']);
        if (Number.isFinite(n) && n >= 0) expectSize = n;
      }
      const expectSha = String(req.headers['x-file-sha256'] || '').toLowerCase() || null;

      // ===== 断点续传核心 =====
      // 稳定分片 id（前端用 文件名+大小+sha 生成），同名同内容重连能续上；老前端无 id 时回退到文件名+大小
      const rawId = String(req.headers['x-file-id'] || '');
      const fileId = rawId || (finalBase + '|' + (expectSize == null ? '?' : expectSize));
      let claimOffset = parseInt(req.headers['x-file-offset'] || '0', 10);
      if (!Number.isFinite(claimOffset) || claimOffset < 0) claimOffset = 0;

      // 稳定分片路径（无随机后缀），中断后保留，下次续写
      const tmpPath = partPathFor(resolved, subDir, fileId);
      UPLOAD_DIRS.add(resolved);
      // 以服务端实际分片大小为准；前端声明对不上则让它重新查 resume
      let realOffset = 0;
      try { realOffset = fs.statSync(tmpPath).size; } catch (_) {}
      if (realOffset !== claimOffset) {
        res.writeHead(409, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: false, error: '分片偏移不匹配，请重新查询续传点', resumeNeeded: true, offset: realOffset }));
      }
      // 分片已完成（offset 已等于期望大小）→ 前端应已秒传；保险起见直接校验落盘，不重复接收
      if (expectSize != null && realOffset === expectSize) {
        // 落到下面的收尾逻辑处理（本次没有数据流入，ws 会立即 finish）
      }

      const appendMode = realOffset > 0;
      const ws = fs.createWriteStream(tmpPath, { flags: appendMode ? 'a' : 'w', highWaterMark: 1024 * 1024 });
      let written = realOffset;
      let finished = false;

      // keepPart=true：网络中断，保留已收分片供续传；false：内容损坏，丢弃
      const fail = (msg, code = 409, keepPart = false) => {
        if (finished) return;
        finished = true;
        try { ws.destroy(); } catch (_) {}
        if (!keepPart) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
        if (!res.headersSent) {
          res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: msg, offset: keepPart ? written : 0 }));
        }
      };

      req.on('data', (chunk) => { written += chunk.length; });
      req.on('aborted', () => fail('客户端中断上传（分片已保留，可续传）', 499, true));
      req.on('error', () => fail('网络中断（分片已保留，可续传）', 499, true));
      ws.on('error', (e) => fail(e.message, 500, false));
      ws.on('finish', async () => {
        if (finished) return;
        // 大小不符：不足说明传了一半（保留分片让前端续传），超出说明数据错乱（丢弃）
        if (expectSize != null && written !== expectSize) {
          if (written < expectSize) return fail(`分片未收齐：期望 ${expectSize} 字节，已有 ${written} 字节，可续传`, 409, true);
          return fail(`分片超出：期望 ${expectSize} 字节，实际 ${written} 字节`, 409, false);
        }
        // 对整文件流式算哈希（含之前续传的部分），不整包进内存
        let actualSha;
        try {
          actualSha = await hashFile(tmpPath);
        } catch (e) {
          return fail('校验读取失败：' + e.message, 500, false);
        }
        if (finished) return;
        if (expectSha && actualSha !== expectSha) {
          return fail('校验失败：文件内容与发送方不一致（SHA-256 不匹配）', 409, false);
        }
        // 校验通过 → 计算最终文件名（避开重名）并原子改名
        let finalName = finalBase;
        let counter = 1;
        const base = path.basename(finalBase, path.extname(finalBase));
        const ext = path.extname(finalBase);
        while (fs.existsSync(path.join(resolved, subDir, finalName))) {
          finalName = base + '_' + (counter++) + ext;
        }
        const filePath = path.join(resolved, subDir, finalName);
        try {
          fs.renameSync(tmpPath, filePath);
        } catch (e) {
          return fail('保存失败：' + e.message, 500, false);
        }
        finished = true;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true, name: finalName, path: filePath, size: written, sha256: actualSha,
          verified: expectSha ? 'sha256' : (expectSize != null ? 'size' : 'none'),
          resumed: appendMode, resumedBytes: realOffset,
          files: [{ name: finalName, size: written, sha256: actualSha }],
        }));
      });
      req.pipe(ws);
      return;
    }

    // multipart/form-data 兼容：仍支持，但大文件建议用原始流
    const chunks = [];
    let totalSize = 0;
    const MAX_MULTIPART = 512 * 1024 * 1024; // 512MB 上限，避免 OOM
    let aborted = false;
    req.on('data', chunk => {
      totalSize += chunk.length;
      if (totalSize > MAX_MULTIPART) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'multipart 单次过大，请改用流式上传或拆分文件' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = boundaryMatch[1].replace(/^["']|["']$/g, '');
        const boundaryBuf = Buffer.from('--' + boundary, 'latin1');
        const endBoundaryBuf = Buffer.from('--' + boundary + '--', 'latin1');
        const crlfcrlf = Buffer.from('\r\n\r\n', 'latin1');

        const results = [];
        let pos = 0;

        while (pos < buffer.length) {
          const nextBoundary = buffer.indexOf(boundaryBuf, pos);
          if (nextBoundary === -1) break;
          if (buffer.indexOf(endBoundaryBuf, nextBoundary) === nextBoundary) break;

          const headerStart = nextBoundary + boundaryBuf.length + 2;
          const headerEnd = buffer.indexOf(crlfcrlf, headerStart);
          if (headerEnd === -1) break;

          const headerStr = buffer.subarray(headerStart, headerEnd).toString('latin1');
          let filename = '';
          const fnStarMatch = headerStr.match(/filename\*=(?:UTF-8''|utf-8'')([^;\s]+)/i);
          if (fnStarMatch) {
            try { filename = decodeURIComponent(fnStarMatch[1]); } catch (_) { filename = fnStarMatch[1]; }
          } else {
            const fnMatch = headerStr.match(/filename="([^"]*)"/);
            if (fnMatch && fnMatch[1]) {
              try { filename = Buffer.from(fnMatch[1], 'latin1').toString('utf8'); } catch (_) { filename = fnMatch[1]; }
            }
          }
          filename = path.basename(filename).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_');

          const contentStart = headerEnd + 4;
          const afterContent = buffer.indexOf(boundaryBuf, contentStart);
          const contentEnd = afterContent !== -1 ? afterContent - 2 : buffer.length - 2;
          const fileData = buffer.subarray(contentStart, Math.max(contentStart, contentEnd));

          if (filename && fileData.length > 0) {
            let finalName = filename;
            let counter = 1;
            const base = path.basename(filename, path.extname(filename));
            const ext = path.extname(filename);
            while (fs.existsSync(path.join(resolved, finalName))) {
              finalName = base + '_' + (counter++) + ext;
            }
            fs.writeFileSync(path.join(resolved, finalName), fileData);
            results.push({ name: finalName, size: fileData.length });
          }

          pos = contentEnd + 2;
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, files: results }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 删除文件/目录 ===
  if (reqPath === '/api/delete' && method === 'DELETE') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { paths: deletePaths } = JSON.parse(body);
        if (!Array.isArray(deletePaths) || deletePaths.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '请指定要删除的文件或目录' }));
        }

        const results = [];
        for (const p of deletePaths) {
          const resolved = path.resolve(p);
          if (!isPathSafe(resolved)) {
            results.push({ path: p, error: '不在允许范围内' });
            continue;
          }
          try {
            fs.rmSync(resolved, { recursive: true, force: true });
            results.push({ path: p, ok: true });
          } catch (e) {
            results.push({ path: p, error: e.message });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, results }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 创建目录 ===
  if (reqPath === '/api/mkdir' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { parent, name } = JSON.parse(body);
        if (!name || !parent) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '缺少参数' }));
        }
        const safeName = name.replace(/[\\\/:*?"<>|]/g, '_');
        const resolved = path.resolve(parent, safeName);
        if (!isPathSafe(resolved)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '不在允许范围内' }));
        }
        fs.mkdirSync(resolved, { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: resolved }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 浏览目录（供目录选择器使用）===
  if (reqPath === '/api/browse' && method === 'GET') {
    let browsePath = url.searchParams.get('path') || '/';
    browsePath = path.resolve(browsePath);
    if (!isPathSafe(browsePath)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '禁止访问' }));
    }
    try {
      const stat = fs.statSync(browsePath);
      if (!stat.isDirectory()) browsePath = path.dirname(browsePath);
      const entries = fs.readdirSync(browsePath, { withFileTypes: true });
      const dirs = [];
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) {
          dirs.push({ name: e.name, path: path.join(browsePath, e.name) });
        }
      }
      dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ current: browsePath, parent: path.dirname(browsePath), dirs }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
  }

  // === API: 重命名 ===
  if (reqPath === '/api/rename' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { path: oldPath, name: newName } = JSON.parse(body);
        if (!oldPath || !newName) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '缺少参数' }));
        }
        const resolved = path.resolve(oldPath);
        if (!isPathSafe(resolved)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '不在允许范围内' }));
        }
        const newPath = path.join(path.dirname(resolved), newName);
        if (!isPathSafe(newPath)) {
          res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: '目标路径不在允许范围内' }));
        }
        fs.renameSync(resolved, newPath);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, path: newPath }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 快捷目录 ===
  if (reqPath === '/api/shortcuts' && method === 'GET') {
    shortcuts = loadShortcuts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(shortcuts));
  }

  if (reqPath === '/api/shortcuts' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('格式错误');
        const saved = saveShortcuts(data);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, shortcuts: saved }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 新增存储介质（U盘路径 / 盘符 / 任意可读目录）===
  if (reqPath === '/api/storage/add' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const result = addStorageEntry(data);
        const code = result.ok ? 200 : 400;
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 移除已固定的存储（按 path）
  if (reqPath === '/api/storage/remove' && method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const target = path.resolve(String(data.path || ''));
        if (!target) throw new Error('缺少 path');
        const next = loadShortcuts().filter(s => path.resolve(s.path) !== target);
        saveShortcuts(next);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, shortcuts: next }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // === API: 上传续传查询（秒传检测 + 断点偏移）===
  if (reqPath === '/api/upload-resume' && method === 'GET') {
    const uploadDir = url.searchParams.get('dir') || PAGE_DIR;
    const resolved = path.resolve(uploadDir);
    if (!isPathSafe(resolved)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: '上传目录不在允许范围内' }));
    }
    let filename = url.searchParams.get('name') || '';
    try { filename = decodeURIComponent(filename); } catch (_) {}
    const expectSize = Number(url.searchParams.get('size') || 0);
    const expectSha = String(url.searchParams.get('sha') || '').toLowerCase();
    const rawId = String(url.searchParams.get('id') || '');
    const fileId = rawId || (filename + '|' + (Number.isFinite(expectSize) ? expectSize : '?'));

    // 解析出与上传一致的目标目录/文件名
    const rawParts = String(filename).split(/[\\/]+/).filter(Boolean);
    const safeParts = rawParts.filter(p => p !== '.' && p !== '..');
    let finalBase = safeParts.length ? safeParts[safeParts.length - 1] : 'upload.bin';
    finalBase = finalBase.replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_');
    const subDir = safeParts.slice(0, -1).join(path.sep);
    const partPath = partPathFor(resolved, subDir, fileId);
    const targetPath = path.join(resolved, subDir, finalBase);

    const sendResume = () => {
      // 续传点：已存分片大小（超过期望大小视为损坏，忽略）
      let offset = 0;
      try {
        const st = fs.statSync(partPath);
        if (st.isFile() && (!expectSize || st.size <= expectSize)) offset = st.size;
        else if (st.size > expectSize) { try { fs.unlinkSync(partPath); } catch (_) {} }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, instant: false, offset, expectSize, name: finalBase }));
    };

    // 秒传：目标文件已存在且大小一致（有 sha 则再校验哈希）
    let candidate = null;
    try {
      if (fs.existsSync(targetPath)) {
        const st = fs.statSync(targetPath);
        if (st.isFile() && st.size === expectSize) candidate = st;
      }
    } catch (_) {}
    if (candidate) {
      if (!expectSha) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
          ok: true, instant: true, name: finalBase, path: targetPath,
          size: candidate.size, sha256: null,
        }));
      }
      return hashFile(targetPath)
        .then(h => {
          if (h === expectSha) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true, instant: true, name: finalBase, path: targetPath,
              size: candidate.size, sha256: expectSha,
            }));
          } else sendResume();
        })
        .catch(sendResume);
    }
    sendResume();
    return;
  }

  // === API: 单文件 SHA-256（流式，供前端下载后校验）===
  if (reqPath === '/api/hash' && method === 'GET') {
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '缺少 path' }));
    }
    const resolved = path.resolve(filePath);
    if (!isPathSafe(resolved)) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: '禁止访问' }));
    }
    try {
      const st = fs.statSync(resolved);
      if (!st.isFile()) throw new Error('不是文件');
      const sha = crypto.createHash('sha256');
      const rs = fs.createReadStream(resolved, { highWaterMark: 1024 * 1024 });
      rs.on('data', c => sha.update(c));
      rs.on('error', e => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      rs.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ path: resolved, size: st.size, sha256: sha.digest('hex') }));
      });
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // === API: 批量打包下载为 ZIP（纯 Node 流式 + 内嵌 SHA-256 清单）===
  // 支持 GET ?paths=<urlencoded JSON数组> 或 POST body {paths:[...]}
  if (reqPath === '/api/pack' && (method === 'GET' || method === 'POST')) {
    const respond = (pathsRaw) => {
      let paths = [];
      try {
        if (Array.isArray(pathsRaw)) paths = pathsRaw;
        else if (typeof pathsRaw === 'string') paths = JSON.parse(pathsRaw);
      } catch (_) {}
      if (!Array.isArray(paths) || paths.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '缺少要打包的文件路径' }));
      }
      // 展开目录为文件，收集 zip 内相对路径
      const files = [];
      const seen = new Set();
      function addFile(src, zipName) {
        const rp = path.resolve(src);
        if (seen.has(rp)) return;
        if (!isPathSafe(rp)) return;
        try {
          if (!fs.statSync(rp).isFile()) return;
        } catch (_) { return; }
        seen.add(rp);
        files.push({ src: rp, name: zipName || path.basename(rp) });
      }
      function walk(dir, relBase) {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          if (e.name.includes('.' + UPLOAD_TMP + '.')) continue;
          const full = path.join(dir, e.name);
          const rel = relBase ? relBase + '/' + e.name : e.name;
          if (e.isDirectory()) walk(full, rel);
          else if (e.isFile()) addFile(full, rel);
        }
      }
      for (const p of paths) {
        const rp = path.resolve(String(p));
        if (!isPathSafe(rp)) continue;
        try {
          const st = fs.statSync(rp);
          if (st.isDirectory()) walk(rp, path.basename(rp));
          else if (st.isFile()) addFile(rp, path.basename(rp));
        } catch (_) {}
      }
      if (files.length === 0) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ error: '没有可打包的文件' }));
      }
      return streamZip(files, res, 'DM打包_' + new Date().toISOString().slice(0, 10));
    };
    if (method === 'GET') {
      return respond(url.searchParams.get('paths'));
    }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try { respond(JSON.parse(body || '{}').paths); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // === API: 服务器信息 ===
  if (reqPath === '/api/info' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      pageDir: PAGE_DIR,
      platform: process.platform,
      shortcutsFile: SHORTCUTS_PATH,
    }));
  }

  // === API: 动态检测挂载点（U盘/移动硬盘/盘符） ===
  if (reqPath === '/api/mounts' && method === 'GET') {
    shortcuts = loadShortcuts();
    mountDataDisks();
    const result = scanMounts();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(result));
  }

  // === 静态文件: file-manager.html ===
  if (reqPath === '/' || reqPath === '/file-manager.html') {
    const htmlPath = path.join(__dirname, 'file-manager.html');
    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    } catch (e) {
      res.writeHead(404);
      return res.end('file-manager.html not found');
    }
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

// 大文件传输：关闭默认超时，避免上传/下载中途被掐断
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.listen(PORT, '0.0.0.0', () => {
  const { execSync } = require('child_process');
  mountDataDisks();
  let ips = [];

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address !== '127.0.0.1') {
        ips.push(iface.address);
      }
    }
  }

  if (ips.length === 0) {
    try {
      const out = execSync('ip addr show 2>/dev/null || ifconfig 2>/dev/null', { encoding: 'utf8', timeout: 2000 });
      const matches = out.match(/inet\s+(\d+\.\d+\.\d+\.\d+)/g) || [];
      for (const m of matches) {
        const ip = m.replace('inet ', '');
        if (ip !== '127.0.0.1' && !ips.includes(ip)) ips.push(ip);
      }
    } catch(_) {}
  }

  if (ips.length === 0) ips.push('0.0.0.0');

  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║     📁 网盘文件管理                   ║');
  for (const ip of ips) {
    const url = 'http://' + ip + ':' + PORT;
    console.log('  ║     ' + url + ' '.repeat(34 - url.length) + '║');
  }
  console.log('  ║                                      ║');
  console.log('  ║  开机自启: systemctl enable dm-file   ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
});
