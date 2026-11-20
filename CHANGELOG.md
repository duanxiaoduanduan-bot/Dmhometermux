# dm-family 改动说明

本文汇总近期对 **DMshow / 网盘 / 分阶段安装 / 代理** 的改动，便于部署与回顾。

---

## 1. DMshow · 作品集主页

**相关文件**

| 路径 | 说明 |
|------|------|
| `DMshow/server.js` | 扫描 `library/`，提供 `/api/portfolio`、`/api/profile` |
| `DMshow/index.html` | 作品集 UI、灯箱、自动轮播 |
| `DMshow/library/` | 素材库（丢文件即上线） |
| `DMshow/library/README.md` | 目录约定与 meta 写法 |
| `DMshow/dm-manifest.json` | 端口 **8086**，与 `routes.json` 的 `/show` 一致 |

**能力**

- 个人主页：头像 / 名字 / 短简介 / 标签 / 外链 / 统计
- 文本摘要：读 `library/about.md`，可展开
- 作品集 `works/`、图集 `albums/`、视频 `videos/`、画廊 `gallery/`
- 点击放大（灯箱）、左右键 / 滑动、**自动轮播**
- 网页「编辑资料」会写回 `profile.json` + `about.md`

**用法摘要**

```text
DMshow/library/
  profile.json   about.md   avatar.jpg
  works/项目名/   cover.jpg + README.md + 媒体
  albums/相册名/  *.jpg
  videos/         *.mp4
  gallery/        散图
```

启动：`cd DMshow && node server.js` → `http://127.0.0.1:8086`（代理：`/show`）

---

## 2. DMmedia 网盘（file-manager）

**相关文件**

| 路径 | 说明 |
|------|------|
| `DMmedia/file-manager.js` | 后端 API、流式上传、Range 下载、**存储介质** |
| `DMmedia/file-manager.html` | 前端交互、上传面板、**添加存储** |
| `DMmedia/file-shortcuts.json` | 快捷目录 + 已固定存储（`type: storage`） |
| `DMmedia/FILE-MANAGER.md` | 网盘专项说明 |
| `DMcore/proxy.js` | 大文件代理：关超时、流式 pipe |

**新增存储介质（v2.2）**

- 侧边栏「我的存储」+「添加存储」面板  
- 自动检测：`/media`、`/mnt`、`/run/media`、`/storage`、Windows 盘符  
- 一键 **固定 / 移除**；可手动填路径或「用当前目录」  
- API：`POST /api/storage/add`、`POST /api/storage/remove`、增强 `GET /api/mounts`

**修过的问题**

| 问题 | 原因 | 修复 |
|------|------|------|
| 新建文件夹 / 弹窗「没反应」 | 全局 `click` 立刻 `hideModal()` | 去掉该逻辑，仅遮罩关闭 |
| 「+ 添加目录」无效 | 缺少 `addShortcut` | 已实现 |
| 右键/路径含特殊字符失效 | 路径塞进 `onclick` 字符串 | 改为 `data-*` + 事件绑定 |
| `/files` 无尾斜杠 API 错 | 前缀判断过严 | 兼容 `/files`、`/files/`、直连 `:8087` |
| 大文件上传慢 / 易炸 | multipart 整文件进内存 | **原始二进制流**边收边写 |
| 下载弱 | 无 Range | 支持 **206** + 1MB 缓冲 |
| 长传中断 | Node 默认 requestTimeout | 服务端与代理均 **关闭超时** |

**传输相关**

- 上传：`xhr.send(file)` 原样字节，面板显示 **进度 + MB/s**
- 并发：默认 **2** 路（`UPLOAD_CONCURRENCY`）
- 下载：流式 + Range；批量下载带间隔防浏览器拦截
- 支持文件夹上传
- 面包屑兼容 Windows 盘符路径
- **乱码**：内容原样不转码；文件名 UTF-8（上传 `X-File-Name`，下载 `filename*=UTF-8''`）
- **存储介质**：U 盘/盘符/自定义目录可固定到「我的存储」（见上 v2.2）

**访问**

- 直连（更快）：`http://主机:8087`
- 代理：`http://主机:8080/files`

改完后需 **重启** `file-manager.js`（或 DMmedia 启动脚本）才生效。

**速度说明（预期）**

- 局域网大文件：可接近网卡/磁盘上限，与 FTP **同一量级**，不保证全面超过 FTP
- 瓶颈通常是网络、磁盘、是否走代理，而非故意限速

---

## 3. 分阶段安装（先装 DM）

**相关文件**

| 路径 | 说明 |
|------|------|
| `install.sh` | 总入口 |
| `install/common.sh` | 日志、标记、公共函数 |
| `install/01-dm.sh` | **DM 核心（永远最先）** |
| `install/02-postgis.sh` | PostgreSQL / PostGIS |
| `install/03-apps.sh` | 各服务 npm 依赖 |
| `install/04-start.sh` | 启动托管服务 |
| `install/README.md` | 安装专项说明 |

**默认一键顺序**

```text
dm → postgis → apps → start
```

**常用命令**

```bash
./install.sh              # 全装（先 DM）
./install.sh dm           # 只装核心控制台 + 代理
./install.sh postgis
./install.sh apps
./install.sh start
./install.sh list
./install.sh status
./install.sh help
```

完成标记：`.dm-install/*.done`  
环境：Linux / DevTop（bash）；Windows 本机一般不能直接跑。

---

## 4. 其它连带修改

| 文件 | 改动 |
|------|------|
| `DMcore/proxy.js` | 大文件友好：去 hop 头、timeout=0、流式转发 |
| `DMshow/dm-manifest.json` | 端口与描述对齐作品集 |
| `config.json` / `routes.json` | 既有端口约定未改逻辑；show→8086，files→8087 |

---

## 5. 文档索引

| 文档 | 内容 |
|------|------|
| **本文件 `CHANGELOG.md`** | 全部改动总览 |
| `install/README.md` | 分阶段安装 |
| `DMshow/library/README.md` | 作品素材库约定 |
| `DMshow/README.md` | DMshow 服务说明 |
| `DMmedia/FILE-MANAGER.md` | 网盘问题、用法、性能 |
| `DMcore/README.md` | 控制台原有说明（未重写架构） |

---

## 6. 建议验证清单

1. `./install.sh dm` → 打开 `:8088` 控制台  
2. `cd DMshow && node server.js` → 往 `library/` 丢图 → ↻ 刷新  
3. 网盘 `:8087` → 新建文件夹、上传大文件看 MB/s、下载  
4. 代理路径 `/files`、`/show` 各点一次  

*文档生成对应工作区改动；若你本地还有未合并分支，以实际 diff 为准。*

---

## 7. 部署完整度（v3 · 卸载 / GitHub 同步 / 换机修复）

**本版目标**：任意 Ubuntu 机器 `git clone` → `./install.sh` 即可跑；可一键卸载；代码可同步 GitHub。

**修复（换机必炸级）**

| 问题 | 修复 |
|------|------|
| `DMcore/supervisor/programs/*.conf` 写死 `/config/Desktop/dm-family/` | 改为**安装时按当前路径动态生成**（`install/common.sh` 的 `write_supervisor_programs()`，`01-dm.sh`/`04-start.sh` 调用）；conf 不再入库 |
| `supervisord.conf` 同样写死旧路径 | 删除旧文件，由 `ensure_supervisord_conf` 按需重建 |
| DMshow 托管配置端口错（8089）、无启动脚本 | 补 `DMshow/dmcore-start.sh`（与其他服务统一走 `common/ports.sh`）+ `package.json` |
| DMpageo manifest 端口 8089 | 修正为 **8085**（与 config.json / routes.json 一致） |
| DMmedia manifest 网盘端口写成 8082 | 修正为 **8087** |
| `config.json` 缺 DMshow 条目 | 已补（8086） |

**新增**

| 文件 | 作用 |
|------|------|
| `uninstall.sh` | 一键卸载。默认只停服务+清标记（数据全保留）；`--purge` 清构建产物；`--drop-db` 删库；`--with-postgres` 卸 PG；`--all` 全做；`-y` 免确认 |
| `.gitignore` | 排除媒体（250M+）、`DMgeo/geodata`（269M+）、素材库、node_modules、supervisor 运行时 |
| `sync-github.sh` | `init <仓库>` 首次关联推送；`"说明"` 日常提交推送；`--dry-run` 预览；>5MB 文件自动拦截 |
| `install.sh uninstall` | 主入口转发到 uninstall.sh |

**验证**：101 个代码/文档文件入库，0 数据文件；全部脚本 `bash -n` 通过；conf 生成函数实测路径正确。

**已知边界**：版本升级策略未定（断断暂不控制版本）；Ubuntu 实机全流程未跑（脚本面向 apt 系，语法已静态验证）。

---

## 8. 地图数据初始化（geodata 阶段 · 装完不黑屏）

**背景**：底图数据来自阿里 DataV.GeoAtlas 开源下载、写入 PostGIS，不进仓库；
但新机器装完缺数据直接黑屏。且旧流程有两个断点：

| 断点 | 后果 |
|------|------|
| `02-postgis.sh` 在 apps 之前跑 `import-datav.js`，此时 `pg` 包未装 | 新机导入必失败，被 warn 吞掉 → 空表 |
| `import-world.js` 从未被安装流程调用 | 世界底图缺失 |

**修复**：新增独立阶段 `install/05-geodata.sh`，一键顺序变为

```text
dm → postgis → apps → geodata → start
```

**数据源三选一**（`GEO_SOURCE`）：

| 方式 | 用法 |
|------|------|
| 在线（默认） | `./install.sh geodata` —— 阿里 DataV（行政区划）+ Natural Earth（世界国界），脚本内置重试与离线缓存 |
| 本地导入 | `./install.sh geodata --local <目录>` —— 支持完整缓存布局或散装 geojson/json/gpx；`map-boundaries/` 一并拷入 |
| 跳过 | `SKIP_GEODATA=1`（兼容旧 `SKIP_DATAV=1`） |

**其它**：02-postgis.sh 不再负责数据导入（时机错误已移除）；导入时若 PG 未运行会临时拉起、导完恢复；结束打印 Basemap 省/市/区行数与底图文件校验。日常导入自有数据还可用 DMgeo「数据库管理」页（`POST /api/pg/tables/:name/upload`，GeoJSON/CSV）。

---

## 9. Ubuntu 实机首测修复（v3.1）

首次真机安装暴露的问题，已全部修复。**原则性改动：所有阶段不再"假完成"——校验不过就报错退出，状态页不再说谎。**

| 症状 | 根因 | 修复 |
|------|------|------|
| DMcore :8088 无响应 | Ubuntu 23.04+ PEP 668 禁止 pip 直装系统 Python，Flask 安装静默失败 | `01-dm.sh` 优先 `apt install python3-flask`，pip 兜底加 `--break-system-packages`；健康检查失败则阶段报错并打印 dmcore.log 尾部 |
| DMcore 被跳过不启动 | `pgrep -f "python3 app.py"` 误匹配机器上其他同名项目 | `common.sh` 改为只判断端口监听 |
| postgis 阶段失败 | apt 装完 PG 集群常已自动运行，`pg_ctlcluster start` 报 "already running" 触发 `set -e` 退出；非 root 无 sudo fallback | `02-postgis.sh` start 幂等化 + sudo 自适应 + `pg_isready` 验证；结尾校验 Basemap+postgis 扩展真实可用才标记完成 |
| dm-dm-postgis 疑似崩溃循环 | supervisord 以普通用户跑时 `su postgres` 需密码交互直接失败 | `dm-postgis/dmcore-start.sh` 自动 `sudo -n`，不可用则打印明确提示退出 |
| geodata 显示"已完成"但库里没数据 | import 失败被 warn 吞掉仍 mark_done | `05-geodata.sh` 校验省数据行数>0 且底图文件存在，否则 error；--skip 不再写标记 |
| start 阶段 RUNNING 假象 | start all 后 2 秒看状态，崩溃循环看不出 | `04-start.sh` 5 秒后二次检查 FATAL/BACKOFF/EXITED 并列出日志路径 |

**重跑指引**（已 clone 的机器）：`git pull` 后按缺口重跑阶段即可（全部幂等）：
`./install.sh postgis` → `./install.sh geodata` → `./install.sh dm` → `./install.sh start`。

---

## 10. DMgeo · 地图编辑 / 展示屏（2026-08-01 前端改动）

**相关文件**

| 路径 | 说明 |
|------|------|
| `DMgeo/map-player.html` | 地图编辑：连线（多段 + 命名） |
| `DMgeo/dashboard.html` | 大数据展示屏：路径总览折叠 + 站点名 |
| `DMgeo/server.js` | `/save-geodata`（UPSERT by clientId）、`/api/geo` 读写 |

**本次改动**

- **连线支持多段折线**：依次点多点，双击地图 / 按 Enter 完成一条（可连续画多条）；点末尾已选点撤销、重复点忽略防自环。
- **连线命名**：完成时弹框命名，默认 `起点 → 终点 (+N段)`，取消不丢线、留空回退默认名；名写入 `features.name` 随 `autoSave` 入库。
- **路径总览可折叠**：每条线路手风琴卡片，展开看类型/长度(或顶点数)/媒体/创建时间。
- **展开显示站点名**：「途经站点 (N)」按坐标匹配同库命名点要素（`MultiPoint`）显示站名，无匹配退化坐标。
- **修 MultiLineString 长度算成 0m**：`flatCoords()` 展平后 haversine 正确累加。

**数据模型**：点 → `MultiPoint`、线 → `MultiLineString`，`properties.name` 即站名/线名；命名经 `/save-geodata` UPSERT，已端到端验证中文名写入读回一致、删除无残留。

---

## 11. 迁入 Dm-family-v3 联合功能（2026-11-20）

从 `D:/Dmhome/dm-family-v3`（main @ 11b9ff7，Ubuntu 现行版）把 10 月新增的**跨服务联合功能**迁进 termux 仓库。两个仓库是分叉的，采用**补丁式移植**：只往当前版加新功能，保留 termux 版已有改进（写真馆轮播常显/内联预览、armPlay 自动播放兜底、music 居中修复、DMChat 恢复码 sha256 体系）。

**迁入功能**

| 功能 | 文件 | 说明 |
|------|------|------|
| DMmedia 转播融合 | `DMmedia/server.js` `storage-config.json` `remotes.html` `index.html` | serverId+remotes、7 个 list 联邦聚合、/api/hello、/api/remotes CRUD、/remote/ 反代透传 Range、UDP 自动发现(18081，只修正已握手 remote 的 IP) |
| 六播放器按名字搜索 | `DMmedia/*-player.html`×6 | 每播放器独立搜索栏、点了直接播；纯前端筛 `*-list.json`，远端转播内容天然可搜 |
| 断点续播 + 自动定位 | 同上 | `dmmedia_resume_<type>` 每大类一条，打开自动续上次；剧集记住第几部第几集 |
| 门户 6 tab | `DMpageo/index.html` `portal.js` | 媒体8081/聊天8083/地理8084/主页8086/网盘8087/控制台8088 |
| DMChat 聊天记录持久化 | `DMChat/server.js` `index.html` | chatlogs/YYYY-MM/ 按月落盘、📜记录按钮(查日期/明细/导出TXT)、入群加载当日历史、HTTPS WSS handler 复用修复 |

**刻意未迁入（安全模型差异）**：Dmhome 版把恢复码从 `sha256` 改成明文以支持"查看恢复码"——这是安全倒退，当前版保留 sha256 + 恢复码仅注册时显示一次的机制。

**移植策略**：DMmedia/server.js 当前版是 Dmhome 版严格功能子集 → 整文件替换；book-reader/audio 播放器与门户两文件当前版无独立改动 → 整文件替换；tvdrama/mv/music 以 Dmhome 为基线补回 armPlay + music 居中 CSS；album 以当前版为底补丁式加搜索/续播（写真馆改进不丢）；DMChat server.js + index.html 补丁式，历史面板渲染改用当前版 `addChatMsg/fileStore` 机制（不依赖 Dmhome 的 renderBubble）。

**验证**：6 播放器 + DMChat index 的内联 JS 全过 `node --check`；DMmedia server.js、DMChat server.js 语法通过；本机实测启动 DMmedia（PORT=18091）→ /api/hello 返回 serverId+8 媒体类型、/api/remotes、7 个 list 端点全 200；DMChat（PORT=18093）→ / 200、/api/chat-dates 与 /api/chat-history 未登录返回 403（鉴权正确）；无 termux 绝对路径残留。测试产物（serverId/ users.json/ chatlogs/ list 缓存）已全部还原。

---

## 12. 网盘完整性校验与批量传输（v2.3 · 2026-11-20）

解决「批量下载容易断点坏道 / 上传中断留半截文件」。改动文件：`DMmedia/file-manager.js`、`DMmedia/file-manager.html`，文档 `DMmedia/FILE-MANAGER.md`。

**根因**：旧批量下载是逐个裸 `<a download>`（无校验，网络中断即存成半截坏文件）；上传直接写目标文件、重名加 `_1` 后缀（中断留残片、无完整性校验）。

**新增能力**

| 改动 | 说明 |
|------|------|
| 两种批量下载 | 「📦 打包下载」= 一次请求打成 ZIP（纯 Node 流式 store，无系统 zip 依赖；含 `__MANIFEST.json` 记 SHA-256+大小）；「⬇️ 校验下载」= 逐文件 fetch + 大小/SHA-256 双校验 + 失败重试 3 次 |
| 上传原子落盘 | 前端先算本地 SHA-256（内置纯 JS，http 可用）随 `X-File-Size`/`X-File-SHA256` 上传；服务端写隐藏 `.upload-part` 临时文件、边收边算哈希，校验通过才原子 `rename`，不符则 409 删除临时文件 |
| 隐藏残片 | `.upload-part` 临时文件在 `/api/list` 中过滤，不污染视图 |
| 新 API | `/api/hash?path=`（流式 SHA-256+大小）、`/api/pack?paths=`（批量 ZIP，可含目录递归） |

**验证**：纯 JS SHA-256 过标准向量（空串/a/abc/123456789/多字节/1MB）；CRC32 过标准向量；设备上 `/api/hash` 正确、`/api/pack` 下载的 ZIP 经 Python `zipfile.testzip()` = ALL OK 且清单哈希全部匹配；上传正确=200(verified=sha256)、错误哈希与谎报大小均 409 且无文件/`.part` 残留；页面 200、服务 runit 单进程无孤儿。测试产物已清理。改动由断断 commit/push。

---

## 13. 网盘断点续传与秒传（v2.4 · 2026-11-20）

在上节完整性校验基础上补齐断点续传。改动：`DMmedia/file-manager.js`、`DMmedia/file-manager.html`，文档 `DMmedia/FILE-MANAGER.md`。

**上传续传**：新增 `/api/upload-resume`（秒传检测 + 断点偏移）；`/api/upload` 改用稳定分片 `.xxx.upload-part`（`X-File-Id` = 文件 sha）+ `X-File-Offset` 追加写，中断保留分片；收齐后对整文件流式重算 SHA-256，一致才原子落盘；谎报 offset 返回 409 `resumeNeeded` 让前端重查；分片在列表隐藏、24h 自动清理。前端上传前查断点、只发缺失部分、中断自动重连（4 次）重查断点，UI 显示「秒传 / 续传自 X%」。

**下载续传**：服务端 `/api/download` 原本已支持 HTTP Range(206)，无需改后端；文件右键新增「复制续传命令（PC）」，生成 `curl -L -C -` 与 `aria2c -c` 命令，PC 端中断重跑同一命令即续传。浏览器端不做持久化续传（OPFS/IndexedDB 在手机 Web 不稳、大文件易 OOM）。

**验证（真机 192.168.1.21）**：`node --check` 前后端通过；实测「传 4 字节中断 → 查得 offset=4 → 续传 6 字节 → 文件 = abcdefghij 且整文件 sha 匹配、resumed=true」；秒传 instant=true；谎报 offset 得 409 resumeNeeded 且原文件无损；下载 `Range: bytes=4-9` 返回 206 + Content-Range，`curl -C -` 拼出完整文件；列表不泄漏分片；服务单进程无孤儿；测试产物已清理。改动由断断 commit/push。

---

## 14. 联邦网盘 · 全网视图（v2.5 · 2026-11-20）

把转播融合的 `remotes` 从"媒体播放列表聚合"扩展到"文件级聚合"——网盘顶栏「🌐 全网」可浏览所有握手设备的文件并勾选跨设备下载，实现通过 PTP 设备联合把各自存储连成一个网络硬盘。改动：`DMmedia/file-manager.js`、`DMmedia/file-manager.html`，文档 README / ARCHITECTURE §12 / FILE-MANAGER。

**后端**：8087 网盘直接读同目录 `storage-config.json` 的 serverId/remotes（与 8081 共享同一份配置，握手后即时生效无需重启）；新增 `/api/global/devices`（设备列表 + `/api/info` 在线探测）与唯一入口 `/api/global/proxy?device=&api=&...`（本机→127.0.0.1:8087 复用本机逻辑，远端→其网盘；透传 Range/Content-* 头；只认登记过的 id 防 SSRF）。远端端口默认同本机 8087，支持 `filePort`/`fileBase` 覆盖。

**前端**：顶栏「🌐 全网」全屏视图——设备分栏 + 目录浏览 + 勾选；文件 `path` 编码为 `dev:<id>:<真实路径>`，下载/校验/打包经 `globalApiUrl()` 自动走 global proxy，本机视图零改动；打包按设备分组（各打一个带 SHA-256 清单的 ZIP）；复用已有 SHA-256 校验 + 断点续传。

**验证（真机 192.168.1.21，双实例模拟）**：起 8089 第二实例当"设备 B"，storage-config 配 remote（fileBase→8089）：`/api/global/devices` 显示 self + 设备B 在线；跨设备 list 可见远端文件、hash sha 匹配；跨设备完整下载内容正确、Range 请求返回 206 + Content-Range + 来源设备头；跨设备 pack 的 ZIP 经 Python zipfile `testzip()`=ALL OK、清单齐全。验证后还原配置（remotes 回空）、关 8089、删测试文件；主实例单进程无孤儿。改动由断断 commit/push。

---

## 15. 修复网盘动态内容全空（v2.5 回归 · 2026-11-20）

修复断断反馈的"网盘左侧没有了"：打开 8087 后侧边栏快捷目录与文件列表全空，顶栏静态按钮正常。

**根因**：`DMmedia/file-manager.html` 有一句孤立的 `async` 关键字独占一行（上一版本把 `uploadOneFile` 改为 async 时误留）。`node --check` 语法检查能通过，但浏览器运行时抛 `ReferenceError: async is not defined`，导致整段 `<script>` 顶层执行中断、启动 IIFE 不运行，侧边栏与文件列表都无法渲染。后端接口全部正常，故现象具有迷惑性。

**修复**：删除孤立 `async`，仅保留 `async function uploadOneFile`。已同步设备、两端哈希一致，页面 HTTP 200、服务单进程无孤儿。

**教训**：前端改动除 `node --check` 外，须再用 Node + DOM stub `eval()` 整段内联 JS 捕获此类运行时 `ReferenceError`。
