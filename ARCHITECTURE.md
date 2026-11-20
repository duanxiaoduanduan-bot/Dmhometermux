# 设计逻辑（ARCHITECTURE）

本文档说明 dm-family 各部分的**设计逻辑与边界约定**，配合 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 排坑。
面向「重装 / 接手 / 改架构」场景：把为什么这么设计、哪些红线不能碰写清楚，避免重复踩坑。

---

## 1. 总体架构

```
                         Termux / Android 宿主（192.168.1.21）
  浏览器/手机 ──局域网──►  DMcore 统一入口 proxy :8080  ──反向代理──► 各 dm-* 服务(:8081~8088)
                                   │
                                DMcore 控制台 :8088（进程/项目管理 + 代理）
                                   │
                       runit (termux-services) 托管 7 个 dm-* 服务
                                   │
                        PostgreSQL 18 + PostGIS 3.6（宿主 mmap 共享内存）
```

- **全家服务跑在 Termux 宿主**，不进 proot、不进 Docker。
- **进程托管统一用 runit**（termux-services），每个服务一个 `runsv` 实例，目录在 `$PREFIX/var/service/dm-<name>/`。
- 数据库是 **PostgreSQL 18 + PostGIS 3.6**，由 `dm-postgis` 服务托管，其余服务按库直连。

---

## 2. 部署架构（为什么弃 proot / supervisord）

### 2.1 为什么不用 proot-distro

早期方案把全家服务跑在 proot Ubuntu 内。实测 **proot 的 ptrace 拦截会让 PostgreSQL 共享内存初始化永久挂死**：
`initdb` 阶段必卡（验证过 PG14/15/16 全部中招），与版本/参数无关。termux 宿主**没有 `/dev/shm`，PG 自动改用 mmap 共享内存**，反而一切正常（`initdb`/`pg_ctl`/`CREATE EXTENSION postgis` 全通）。

> 结论：**DM 全家服务跑 termux 宿主**（不再用 proot 执行）。`termux.sh` 已重写为「宿主装 git+termux-services → 复用/克隆仓库 → 直接 `bash ./install.sh`」，不再装 proot-distro、不再 `proot-distro login`。

### 2.2 为什么不用 supervisord

`supervisord` 在 termux 因所有目录 `NO_HARDLINK`、`os.link` 缺失，建 socket 会失败，同样是死路。runit 是 termux 官方 postgres/sshd 同款机制，可靠。

### 2.3 普通 Linux（非 termux）怎么办

非 termux 环境仍走原 `supervisord` 路径（`install.sh` 里的 `is_termux` 分支判断）。本文档的 runit 约定只在 termux 生效。

### 2.4 远程设备要点

- 设备 IP：`192.168.1.21`（DHCP 会漂，历史 .38→.40→.41→.93→.21），SSH 8022，别名 `ssh arm`（HostName 需随 IP 更新）。
- Android 锁屏后 sshd/后台网络常被系统回收 → 唤醒：`termux-wake-lock`；sshd 被回收则 `pkill sshd; sshd`。
- **本机（Windows）直连设备端口实测可达**（HTTP 200），一般无需隧道；仅当网段隔离时用 `ssh -N -L <本地端口>:127.0.0.1:<端口> arm`。

---

## 3. 服务托管机制（runit）

### 3.1 服务目录

```
$PREFIX/var/service/dm-<name>/
├── run        # 启动脚本（必须 exec 或正确多进程写法）
└── log/run    # svlogd 日志
```

`install/common.sh` 生成 `run`；`runit_up` 兼容「runsvdir 在/不在」两种场景（在→轮询等 socket；不在→`setsid runsv` 兜底），最后 `sv status` 轮询直到 `^run:`。

### 3.2 单进程服务：run 脚本末行必须 `exec`

runit 的 `run` 文件是 `exec bash dmcore-start.sh`，runsv 直接托管 bash。若写成 `"$NODE_BIN" server.js`（无 `exec`），node 只是 bash 子进程，`sv restart` 只终止 bash，**node 变孤儿继续占端口**，新进程 `EADDRINUSE` 起不来 → 表现为「scp 上去的新代码怎么改都不生效」，且 `sv status` 的 pid 与真正提供服务的进程对不上。

> 所有单进程服务（DMgeo / DMChat / DMshow / DMpageo / DMcore）的 `run` 末行都已改为 `exec`。

### 3.3 多进程服务（DMmedia）：不能 exec 的正确写法

DMmedia 同时跑 `server.js` + `file-manager.js` 两个 node，故：
1. **先注册** `trap shutdown_children TERM INT EXIT` **再**启动子进程（trap 写在两个 `&` 之后有竞态窗口）；
2. 显式记录 `SRV_PID/FM_PID` 定向 `kill -TERM`，不依赖 `kill 0` 的进程组假设；
3. TERM 后最多等 5s，仍存活则 `kill -KILL`，确保端口一定释放；
4. 裸 `wait` 必须改 **`wait -n`**——任一子进程退出即整体退出交 runsv 重启，否则 server.js 挂了 file-manager 还活着，服务半死而 runsv 毫无察觉。

> **新增多进程服务时照抄这套四规则**，提交前 `bash -n` 过一遍。

### 3.4 排查孤儿进程

`sv restart` 后新进程一直 `EADDRINUSE`，元凶常是 `PPID=1` 的游离 `node server.js` 占着端口：

```bash
for p in $(pgrep -f "node server.js"); do echo "$p -> $(readlink /proc/$p/cwd)"; done
# 找到 PPID=1 的 kill 掉再 restart
```

termux 无 `/tmp`，临时文件用 `$PREFIX/tmp`。

---

## 4. 数据库三库设计

三库均在 termux 宿主 PG18 + PostGIS3.6，分工严格：

| 库 | 职责 | 写入方 |
|----|------|--------|
| `trip` | 主库：要素 `features` 表 + 边界 CRUD 写入 | server.js 边界 POST/PUT/upload/DELETE 走 `pgPool` |
| `Basemap` | 中国省/市/区底图原档（`import-datav.js` 写入 provinces/cities/districts；`features` 表也建在此）+ **统计镜像表 `stats_features`** | 导入脚本 + 统计同步 |
| `dmpageo` | 世界国界 `countries`（`import-world.js` / `rebuild-postgis.js`） | `install/02-postgis.sh` 建库启用 postgis；`uninstall.sh` 同步删 |

边界读取路由（`server.js` GET /api/geo/boundaries）countries/provinces/cities **全部走 `basemapPool`(Basemap)**；写入路由 POST/PUT/upload/DELETE **全部走 `pgPool`(trip)**——与参照 `dm-family-v3` 1:1 对齐，非本项目引入分歧，勿擅自改库引用。

### 4.1 国界数据源铁律

**世界国界底图必须用 Natural Earth 50m（`ne_50m_admin_0_countries`）**，不能用 110m。110m 分辨率会省略新加坡等微型国家/城市国家，导致海外要素无法 `ST_Contains` 匹配国家、`regional-stats` 的 countries 永远空、世界地图缺国界。`import-world.js` 的 `SRC` 已永久改 50m。

### 4.2 运行期补丁（非持久，重装需注意）

- `dmpageo.countries`（177 行）曾用 `pg_dump -d dmpageo -t countries -c | psql -d Basemap` 复制到 `Basemap.countries`，让国界 API 直接返回。重置 PG（`rm -rf $PREFIX/var/lib/postgresql` 后 `initdb`）后 `Basemap.countries` 消失、API 回 500，需重跑该命令；要持久须改 import 脚本让 `import-world.js` 也写 Basemap。
- 新建库自愈：`server.js` 的 `resolveSuperUser()`（候选 `PGSUPERUSER`→`os.userInfo().username`→`postgres`）+ `ensureFeatureStore(db)`（补 postgis 扩展 + features 表 + GIST 索引 + dmuser 全量授权含 ALTER DEFAULT PRIVILEGES），**建库时调用 + 首次访问该库时自动自愈**。根因是旧代码用非超级用户 dmuser 执行 `CREATE EXTENSION postgis` 必失败且被 catch 吞掉 → 库建出来却没有 features 表。

---

## 5. 统计口径与镜像表架构

### 5.1 统计口径铁律（按选的库统计）

dashboard 上凡是**要素维度**的数字，必须只来自当前选中库（`dbUrl()` 带 `?db=`），唯一口径是 `countFeatures(mapData)`（按 `properties.type` 分类：point/line/polygon/timePath/photo/video）。

**全局静态资源**（`geodata-list.json` 素材清单、`tvdrama/music/video/album/book/audio-list.json` 媒体库共约 590 条）与任何数据库无关，**绝不可计入「全部要素」、也不可与库内要素同分母算百分比**，必须单独成段并标注「全局」。二者混算会导致切任何库「全部要素」恒为 591、分布图里库内要素被压成 0.2%，被误认为「新库数据没进统计」。

### 5.2 点亮 / 镜像架构（每库独立）

- 每库基于 Basemap 边界 `ST_Contains` 落点 + 统计，**每库独立点亮**，互不影响。
- `regional-stats` 实现为「选中库.features → 同步进 `Basemap.stats_features` 镜像 → 从镜像统计」，模块级串行锁防并发覆盖。
- **镜像目标表必须独立于任何可选源库的表**。`syncFeaturesToBasemap` 源库无 features 表/无要素时**同步空集**（否则切库后统计显示的是上一个库的陈旧数据）。

### 5.3 自引用坑（已修）

早期镜像目标是 `Basemap.features`，而 `Basemap` 自己也能被选为源库 → 选 Basemap 时统计跟着上一次查的库变（串库）。现镜像表 = `Basemap.stats_features`（`ensureStatsMirror()` 幂等建表 + GIST 索引），`Basemap.features` 回归「Basemap 自己的要素源」语义。

---

## 6. 前端切库逻辑

切库 = **清图层 + 停写 + 重载 + 全刷**，四步缺一不可（`map-player.html` 的 `switchDb`）：

1. `clearTimeout(autoSaveTimer)` + `_dbLoaded=false` + `_deletedIds=[]`（否则 2 秒后把 A 库内存快照写进 B 库）；
2. `clearFeatureLayers()` 真正 `map.removeLayer()` 摘掉 Leaflet 对象（只清数组不摘图层 = 旧库要素继续画在地图上）；
3. `await autoLoad()` 载新库；
4. `renderAll()` 刷新点/线/面/图层/脚注/表格全部面板。

> 历史坑：原 `switchDb` 调的 `renderAll()`/`loadGeoData()` 压根不存在（ReferenceError 中断）→ 切库既不加载新库也不清旧图层。

### 6.1 全局素材隔离

`geodata` 目录（`.geojson`/`.gpx`）是**全局**的、不属于任何库。旧代码 `loadGeodata()` 直接 `importGeoJSON` 进内存 → 被 `buildGeoJSON` 当当前库要素回写 → 每切一次库就往新库灌一遍（跨库污染）。现改为 `previewGlobalGeo()` 挂独立 `globalGeoLayer`(L.layerGroup) 只读预览（橙色虚线，popup 标注「不属于任何数据库」），`layerGroups.globalGeo` 带 `global:true` 标记 → `renderLayerList` 的「当前库共 N 个要素」必须排除 `global` 图层。入库唯一路径 = 用户点「入库」按钮 → `importGlobalGeoToDb()` 二次确认。

### 6.2 多页共用 localStorage

多页共用 `localStorage['pgm_db']`（dashboard / map-player / db-manager），默认值统一 `'trip'`。`loadDatabases()` 须校正：记住的库不在 `/api/pg/databases` 列表里就回落，否则「下拉显示 A 库、请求发往 B 库」且无任何报错。

---

## 7. 各模块职责

| 模块 | 端口 | 职责 |
|------|------|------|
| **DMcore** | 8088（控制台）/ 8080（proxy） | 运维控制台：进程/项目管理 + 统一反向代理。`proxy.js` 提供 8080 入口，按 `routes.json` 转发到各服务。 |
| **DMChat** | 8083 | 实时对话（WebSocket）。**注册制**：无预置密码，首个注册者自动 admin，账号/邀请码存 `users.json`/`invites.json`（运行时数据，gitignore）。 |
| **DMgeo** | 8084 | 地图轨迹 / 大数据展示屏 / 行政区划管理 / 图层管理 + PostGIS 空间查询。 |
| **DMmedia** | 8081（媒体）/ 8087（网盘 files） | 媒体播放（电视剧/MV/音乐/写真馆/有声书/阅读）+ 存储管理 + 网盘。**双进程**（server.js + file-manager.js）。 |
| **DMpageo** | 8085 | 合并门户：`iframe` 聚合 DMmedia(:8081) 与 DMgeo(:8084) 于同一界面。 |
| **DMshow** | 8086 | 作品集个人主页：`library/` 素材库自动排版，文本摘要 + 作品/图集/视频，全屏幻灯与自动轮播。 |
| **dm-postgis** | 5432（PG） | PostgreSQL 18 + PostGIS 3.6 空间数据库，DMgeo / 统计 / 边界依赖。 |

> 端口集中改：根目录 `config.json`；代理路由：`DMcore/routes.json`；各服务默认端口由 `dmcore-start.sh` 的 `resolve_port` 解析（默认值见各自 `dm-manifest.json`）。

---

## 8. DMcore 控制台 termux 适配

DMcore 控制台（8088）的 `/api/projects` 用「独立 supervisord 实例」查/管 dm-* 状态（`projects.py` 的 `_status` 调 `supervisorctl status`）。但 termux 实际用 **runit** 托管，supervisord 进程不存在 → `supervisorctl` 连不上 → 所有项目被返回 `STOPPED / pid:null / managed:false`（「同步状态」全错乱）。

修复（`DMcore/projects.py`，commit `a406d9d`）：新增 `is_termux()` / `_runit_svc()` / `_sv()`，`_status`/`start`/`stop`/`restart`/`ensure_supervisor` 增加 termux 分支——termux 下状态查询和启停走 **runit(`sv`)**；非 termux 保留原 supervisord 逻辑。并修复 `dm-postgis` 等已含 `dm-` 前缀的服务名拼接重复问题（`_runit_svc` 不再重复拼 `dm-`）。

> `DMcore` 的「服务管理」标签（`/api/services`，systemd）在 termux 返回「未接管」属正常（termux 无 systemd），与 dm-* 无关。

---

## 9. Termux 登录 shell 约定

`~/.bashrc`（设备侧，非仓库）负责登录时打印服务地址提示。历史残留两段已清理（2026-08-01）：

- **`pm2 resurrect`**：PM2 守护进程在跑但 `dump.pm2` 早丢 → 每次登录刷 `[PM2][ERROR]` + 空进程表 + `host metrics` 行。已移除并 `pm2 kill` 停守护进程。
- **「DMpage 开机自启」块**：`pkill node` + `nohup` 起游离实例，会与 runit 双管理、造孤儿进程；且引用的 `download/DMpageo` 目录已不存在（死代码）。已删除。

> **铁律：DM 服务只用 runit 托管，严禁 pm2 / nohup 自启。** 登录 banner 端口见 README 端口表。

---

## 10. 数据边界（什么不进仓库）

媒体文件、`DMgeo/geodata` 地图数据、`DMshow/library` 素材、DMChat 的 `users.json`/`invites.json` —— **运行时数据，已 gitignore，不进仓库、绝不删除**。clone 到新机后 `./install.sh` 的 geodata 阶段会自动下载/导入底图数据；聊天账号需重新注册（首个注册者为 admin）。

---

## 11. DMgeo 前端功能（地图编辑 / 展示屏）

DMgeo 的地图编辑在 `map-player.html`、大数据展示屏在 `dashboard.html`，数据均来自 `api/geo?db=当前库`（跟随页面顶部数据库切换器）。

### 11.1 连线（多段折线 + 命名）

- **进入**：点「🔗 连线」按钮进入连线模式（光标变 pointer，按钮变黄色「🔗 完成」）。
- **画多段线**：依次点多个标记/点（已选点变半透明）；点「最后一个已选点」= 撤销该点；点其它已选过的点（非末尾）被忽略（防自环/重复）。**双击地图 或 按 Enter** 完成当前一条线（可连续画多条）。
- **命名**：完成时弹框让用户输入线路名，**默认填 `起点 → 终点 (+N段)` 自动名**；点取消 → 沿用默认名（不丢线）；留空/只空格 → 回退默认名。名字写入 `features.name` + `properties.name`，随 `autoSave` 经 `/save-geodata` UPSERT（按 `clientId`）入库。
- **存储格式**：线以 `MultiLineString` 入库（服务端 `ST_Multi(ST_MakeValid(ST_GeomFromGeoJSON(...)))`），顶点为 `[lon,lat]`。

### 11.2 路径总览（dashboard.html）

- **可折叠**：每条线路一个手风琴卡片，点标题行展开/收起，明细含类型 / 长度或顶点数 / 顶点数 / 媒体 / 创建时间。
- **展开显示站点名**：明细「途经站点 (N)」按顶点坐标（lat/lon 5 位小数）匹配同库里**带 `properties.name` 的点要素**（`MultiPoint`）显示站点名；无匹配则退化显示坐标。
- **长度修正**：原长度循环未展平多段线导致 `MultiLineString` 长度算成 `0m`；现用 `flatCoords()` 展平后按 haversine 正确累加（km / m）。

### 11.3 要素存储格式要点

- 点要素 → `MultiPoint`；线要素 → `MultiLineString`；均含 `properties.name`（未命名则为空串）。
- 路径总览的站点名匹配、统计口径均依赖此格式；坐标键统一用 `lat.toFixed(5)+','+lon.toFixed(5)`。
- 命名功能已端到端验证：写入带自定义中文名的线 → 读回 `name` 一致 → 删除清理无残留（`/save-geodata` 的 `deleted:[clientId]` 精确删）。

