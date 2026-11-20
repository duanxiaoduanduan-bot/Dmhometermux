# 网盘 file-manager 说明

端口默认 **8087**（`FILE_PORT` / `config.json` → `DMmedia.files`）。  
页面：`file-manager.html`，服务：`file-manager.js`。  
版本：**v2.4**（断点续传 + 秒传 + PC 端续传命令；兼容 v2.3 的 SHA-256 校验 + ZIP 打包下载）。

## 访问

| 方式 | 地址 | 说明 |
|------|------|------|
| 直连 | `http://主机:8087` | 传输通常更快 |
| 代理 | `http://主机:8080/files` | 统一入口，多一跳 |

## 新增存储介质（v2.2）

支持把 **U 盘 / 移动硬盘 / Windows 盘符 / Linux 挂载点 / 任意可读目录** 固定到侧边栏「我的存储」。

### 怎么用

1. 侧边栏底部 **「💾 添加存储」**，或顶栏 **「💾 存储」**
2. **检测到的位置**：插上 U 盘后点 🔄，再点 **固定**
3. **手动添加**：填路径，例如  
   - Windows：`D:\`、`E:\备份`  
   - Linux：`/mnt/usb`、`/media/user/DISK`、`/run/media/...`
4. 也可 **用当前目录** 一键填入后固定  
5. 外接设备列表每项旁的 **📌** = 固定到我的存储  

配置写入：`DMmedia/file-shortcuts.json`（`type: "storage"`）。拔盘后条目仍在，路径不可读时打开会报错，可在管理面板 **移除**。

### 相关 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/mounts` | 扫描外接/盘符/已固定存储 |
| POST | `/api/storage/add` | body: `{ name?, path, type?: "storage" }` |
| POST | `/api/storage/remove` | body: `{ path }` |
| GET/POST | `/api/shortcuts` | 全部侧边栏入口（含 storage） |

## 断点续传与秒传（v2.4）

网络中断不再从头再来。上传和下载两条路都支持续传，思路不同：

### 上传续传（浏览器 → 服务端）

1. 前端上传前算好整文件 SHA-256，先调 `/api/upload-resume`：
   - **秒传**：目标文件已存在且大小一致（有 sha 时再验哈希）→ 直接返回 `instant: true`，一个字节都不传
   - 否则返回 `offset`（已缓存的分片字节数）
2. 前端用 `X-File-Id`（= 文件 SHA-256，稳定标识）+ `X-File-Offset` 只发缺失部分（`file.slice(offset)`）
3. 服务端把分片写成固定名 `.xxx.upload-part`，**中断保留、不删除**；收齐后对**整文件**流式重算 SHA-256，一致才原子改名
4. 网络中断自动重试（最多 4 次），每次重连先重查断点，从服务端实际 offset 接着传
5. 谎报 offset 会被拒（409 + `resumeNeeded`），前端重查后对齐，绝不会错位拼接

> 分片路径只在本地隐藏，不在目录列表显示；超过 24 小时未完成的残留由服务端每小时自动清理。老客户端（不带 `X-File-Id`）回退到原「一次性上传 + 大小校验」，行为不变。

### 下载续传（服务端 → PC）

服务端 `/api/download` 原生支持 **HTTP Range（206 / `Accept-Ranges: bytes`）**，因此**用支持续传的下载工具即可断点续传**，浏览器端不做（手机 Web 存大文件的 OPFS/IndexedDB 方案不稳、易 OOM）。

文件右键菜单 **「🔗 复制续传命令（PC）」** 会生成两种可直接粘贴的命令，中断后**重跑同一条**即从断点继续：

```bash
# curl（多数系统自带，-C - 自动续传）
curl -L -C - -o "电影.mp4" "http://主机:8087/api/download?path=..."

# aria2c（多线程更快，-c 续传；需安装 aria2）
aria2c -c -x4 -s4 -o "电影.mp4" "http://主机:8087/api/download?path=..."
```

### 相关 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/upload-resume?dir=&name=&size=&sha=&id=` | 秒传检测 + 断点偏移：`{ instant, offset, expectSize }` |
| POST | `/api/upload` | 新增头 `X-File-Id`、`X-File-Offset` 实现分片续传；`X-File-Size` 为整文件大小 |

## 完整性校验与批量传输（v2.3）

解决「批量下载容易断点坏道 / 上传中断留半截文件」。核心思路：**传输前后都算 SHA-256，一致才落地，不一致自动丢弃或重试**。

### 两种批量下载（选中文件后批量栏切换）

| 按钮 | 方式 | 完整性保证 | 适用 |
|------|------|-----------|------|
| **📦 打包下载** | 选中项（可含文件夹）一次请求打成 **ZIP** 下载 | ZIP 自带 CRC32（解压即校验）+ 包内 `__MANIFEST.json` 记录每个文件的 SHA-256 和大小 | **推荐**：多文件/文件夹，一次下载不会被浏览器拦截 |
| **⬇️ 校验下载** | 每个文件 `fetch` 流式下载 → 算 SHA-256 → 与服务端比对 → 一致才落盘 | 大小 + SHA-256 双校验，失败自动重试 3 次，串行避免浏览器多下载拦截 | 单个或少量关键文件 |

- ZIP 打包为**纯 Node 实现**（store 模式流式输出，不依赖系统 `zip` 命令——Termux 默认无此命令），视频等本身已压缩，不二次压缩、不吃内存。
- `__MANIFEST.json` 示例：`{ "algorithm": "sha256", "files": [ { "path": "a.mp4", "size": 12345, "sha256": "..." } ] }`，下载后可离线核对每个文件。

### 上传完整性（每次上传自动执行）

1. 前端上传前**分块计算本地 SHA-256**（http 下用内置纯 JS 实现，不依赖浏览器 `crypto.subtle`，因为它仅在 https/localhost 可用）。
2. 请求头 `X-File-Size`（字节数）+ `X-File-SHA256` 交给服务端。
3. 服务端边收边写入**隐藏临时文件** `.xxx.upload-part.<随机>`，同时算 SHA-256 并计数。
4. 收完校验：**大小不符或哈希不符 → 409 拒绝并删除临时文件**（绝不留半截文件、不再产生 `xxx_1` 残片）；**一致 → 原子 `rename` 成正式文件**。
5. 上传面板显示「SHA-256 校验通过」或「大小校验通过」徽标。
6. 临时文件在目录列表中**自动隐藏**，不污染视图。

> 说明：没有 `X-File-SHA256` 的老客户端仍可上传，服务端退化为「大小校验」；两端都提供时才做 SHA-256 比对。

### 为什么不用浏览器原生 crypto

`/api/hash` 返回的 SHA-256 供前端核对。由于网盘通常走 `http://IP:8087`（非安全上下文），浏览器 `crypto.subtle` 不可用，故前端内置了一份经过标准向量校验的纯 JS SHA-256（支持空串/多字节/1MB+ 流式分块）。

### 相关 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/hash?path=` | 流式算单文件 `{ path, size, sha256 }`，供下载后校验 |
| GET/POST | `/api/pack?paths=` | `paths` = URL 编码的 JSON 数组（可含目录，递归展开）；流式返回 ZIP + `__MANIFEST.json` |

## 近期修复（v2.1）

### 按键无响应

1. **弹窗秒关**  
   全局 `document.click` 里调用了 `hideModal()`，点「新建文件夹」等会冒泡后立刻关掉。  
   → 已删除该逻辑，只保留点遮罩关闭。

2. **缺少 `addShortcut`**  
   「快捷目录 → + 添加目录」调用未定义函数。  
   → 已补全，并支持目录选择器。

3. **路径破坏 onclick**  
   右键菜单用字符串拼接路径，引号/特殊字符导致菜单项无效。  
   → 改为 `data-cmd` + `addEventListener`。

4. **API 前缀**  
   仅在 `/files/` 下才加前缀，访问 `/files` 时 API 可能打错服务。  
   → 兼容 `/files`、`/files/` 与直连根路径。

### 传输速度与质量

| 项 | 行为 |
|----|------|
| 上传 | 原始 `application/octet-stream`，边收边写盘，**不整包进内存** |
| 完整性 | `xhr.send(file)` 原样字节，不转码 |
| 进度 | 百分比 + **实时速度 (KB/s·MB/s)** + 已传/总量 |
| 并发 | 默认 2（前端 `UPLOAD_CONCURRENCY`） |
| 下载 | `Accept-Ranges` + **HTTP 206**，1MB `highWaterMark` |
| 超时 | `requestTimeout/headersTimeout/timeout = 0`，避免大文件中断 |
| 代理 | `DMcore/proxy.js` 同步关闭长传超时并流式 pipe |

### 中文 / 乱码

| 对象 | 是否会乱码 | 说明 |
|------|------------|------|
| **文件内容**（图/视频/zip/原文） | **不会** | 二进制原样上下传，不转码、不改编码 |
| **上传后的文件名**（含中文） | **正常** | `X-File-Name` + `encodeURIComponent` / 服务端 decode 一次 |
| **下载保存的文件名** | **现代浏览器正常** | `filename*=UTF-8''...`（RFC 5987）；`filename=` 仅 ASCII 兜底 |
| 路径中的中文目录 | **正常** | `path=` 使用 `encodeURIComponent` |

注意：极老浏览器若忽略 `filename*`，可能看到英文下划线兜底名，内容仍完好。重启 `file-manager.js` 后生效。

multipart 仍兼容，但单次有大小上限提示；**推荐走流式上传**（当前前端默认）。

## 主要 API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/list?path=` | 列目录 |
| GET | `/api/download?path=` | 下载（支持 Range） |
| POST | `/api/upload?dir=&name=` | 流式上传 + 断点续传；头 `X-File-Name`、`X-File-Size`、`X-File-SHA256`、`X-File-Id`、`X-File-Offset` |
| GET | `/api/upload-resume?dir=&name=&size=&sha=&id=` | 秒传检测 + 续传断点 |
| GET | `/api/hash?path=` | 单文件 SHA-256 + 大小 |
| GET/POST | `/api/pack?paths=` | 批量打包 ZIP（内嵌 SHA-256 清单） |
| DELETE | `/api/delete` | body: `{ paths: [] }` |
| POST | `/api/mkdir` | `{ parent, name }` |
| POST | `/api/rename` | `{ path, name }` |
| GET/POST | `/api/shortcuts` | 快捷目录 |
| GET | `/api/browse?path=` | 目录选择器 |
| GET | `/api/mounts` | 外接设备探测 |
| GET | `/api/info` | `{ pageDir }` |

## 界面功能摘要

- 列表 / 网格、排序、多选、**打包下载 / 校验下载** / 删除  
- 拖拽上传、文件夹上传（**SHA-256 校验 + 断点续传 + 秒传**）  
- 侧边栏快捷目录 + 媒体库 + 外接设备  
- 右键：下载 / **复制续传命令（PC）** / 重命名 / 复制路径 / 删除  

## 性能预期（局域网）

- 可与 **FTP 同一量级**，不保证全面超过 FTP  
- 更快路径：直连 `:8087`、有线、目标目录用本机快盘、传大文件  
- 面板上的 MB/s 是实际观感标准  

## 重启

```bash
# 随 DMmedia
bash dmcore-start.sh
# 或
FILE_PORT=8087 node file-manager.js
```
