# 易错点 / 排坑（TROUBLESHOOTING）

每条：**现象 → 根因 → 对策**。配合 [ARCHITECTURE.md](ARCHITECTURE.md) 看设计背景。
大部分坑都源于「termux 宿主 + runit 托管 + PG mmap」这套特殊环境，以及早期 proot/supervisord/PM2 方案的残留。

---

## 1. 重启服务后端口 EADDRINUSE / 改了代码不生效

**现象**：`sv restart dm-XXX` 后新进程起不来（`EADDRINUSE`），或 scp 上去的新代码怎么改都不生效。

**根因**：`run` 脚本没 `exec`，node 成了 bash 子进程；`sv restart` 只杀了 bash，**node 变孤儿（PPID=1）继续占端口**，新进程永远 bind 失败。

**对策**：
```bash
for p in $(pgrep -f "node server.js"); do echo "$p -> $(readlink /proc/$p/cwd)"; done
# 找到 PPID=1、cwd 对应该服务的 kill 掉，再 sv restart
```
根治：单进程服务 `run` 末行 `exec`；多进程（DMmedia）按 ARCHITECTURE §3.3 四规则写。

---

## 2. DMcore 控制台（8088）所有服务显示 STOPPED

**现象**：`/api/projects` 把 7 个 dm-* 全标成 `STOPPED` / `pid:null` / `managed:false`，但服务其实都在跑（`sv status` 全 run、端口都 200）。

**根因**：DMcore 用 supervisord 查状态，termux 实际用 runit，supervisord 进程不存在 → `supervisorctl` 连不上全返回 STOPPED（控制台视角与真实运行视角错位）。

**对策**：已修复 `projects.py`（`a406d9d`），termux 下走 `sv`。若仍异常，确认 `DMcore/projects.py` 含 `is_termux()` 分支且已重启 DMcore。

---

## 3. 本机（Windows）访问设备端口不通

**现象**：浏览器打 `http://192.168.1.21:808X` 打不开。

**根因**：本机与设备不在同一网段/被防火墙隔离（多数情况其实直连可达，先验证）。

**对策**：先在本机 `curl -s -o /dev/null -w "%{http_code}" http://192.168.1.21:808X/` 验证——实测通常返回 200。仅当网段隔离时用隧道：
```bash
ssh -N -L 18084:127.0.0.1:8084 arm   # 然后本机访问 http://127.0.0.1:18084
```

---

## 4. 设备锁屏后所有端口 refused / 连不上 / SSH 连不上

**现象**：能 ping 通但所有端口 refused，或 SSH 连不上。

**根因 A（锁屏回收）**：Android 锁屏会冻结 termux 后台（包括 sshd 和 dm-* 服务进程）。

**对策 A**：点亮设备 → 打开 termux 跑 `termux-wake-lock`（申请唤醒锁）；sshd 被回收则 `pkill sshd; sshd`。长期建议保持 termux 前台/加白名单。

**根因 B（重启后 sshd 不自启，2026-11-20 新机踩到）**：sshd 服务目录里有 `down` 文件（`$PREFIX/var/service/sshd/down`）——runit 语义 = **默认禁用自启**；且当时那条 sshd 是手动起的孤儿进程（PPID=1），设备重启后自然没了。DM 各服务不受影响（安装脚本会 `sv-enable`），唯独 sshd 要单独确认。

**对策 B**（一次修好，以后重启自动起）：

```bash
rm -f $PREFIX/var/service/sshd/down
pkill -f '^sshd' 2>/dev/null; sleep 2
SVDIR=$PREFIX/var/service $PREFIX/bin/sv restart sshd
SVDIR=$PREFIX/var/service $PREFIX/bin/sv status sshd   # 应为 run，PPID=runsv 而非 1
```

> 相关：打开 Termux 不显示服务地址横幅，是全新设备 `~/.bashrc` 为空所致——配 banner 见 [ARCHITECTURE §9](ARCHITECTURE.md)。

---

## 5. 切换数据库后统计数字不变 / 串库

**现象**：选 `trip` 和选 `Basemap` 统计结果一样，或取决于上一次查了谁。

**根因**：镜像目标表自引用——早期镜像写 `Basemap.features`，而 `Basemap` 自身也可选为源库，读到的是上一次同步进来的别的库残留。

**对策**：现镜像表 = `Basemap.stats_features`（`ensureStatsMirror()` 幂等建），每库独立点亮。`syncFeaturesToBasemap` 源库无要素时同步空集。详见 ARCHITECTURE §5。

---

## 6. 重置 PG（initdb）后库无 features 表 / 授权失败

**现象**：重置数据库后某库 `regional-stats` 报错「relation features does not exist」，或写要素 403。

**根因**：旧代码用非超级用户 dmuser 执行 `CREATE EXTENSION postgis` 必失败且被 catch 吞掉 → 库建出来却没有 features 表 / 缺授权。

**对策**：现 `server.js` 有 `resolveSuperUser()` + `ensureFeatureStore(db)` 自愈（建库时 + 首次访问该库时自动补 postgis + features 表 + GIST 索引 + dmuser 全量授权）。重置后访问该库即自动修复。另：重置 PG 会使运行期补丁 `Basemap.countries` 消失，需重跑 `pg_dump -d dmpageo -t countries -c | psql -d Basemap`。

---

## 7. 世界地图缺国界 / 海外要素统计 countries 为空

**现象**：国内省/市/区正常，但世界地图没有国界，或海外要素无法归属国家、`regional-stats` 的 countries 永远空。

**根因**：国界底图用了 Natural Earth **110m**（分辨率低，省略新加坡等微型国家/城市国家），`ST_Contains` 匹配不到。

**对策**：国界数据源必须用 **Natural Earth 50m**（`ne_50m_admin_0_countries`）。`import-world.js` 的 `SRC` 已永久改为 50m，勿改回 110m。详见 ARCHITECTURE §4.1。

---

## 8. 全局素材（geodata 目录）污染当前库

**现象**：切库后发现当前库多了不属于它的要素，或 `geodata/*.geojson` 被当成库内要素回写。

**根因**：旧代码 `loadGeodata()` 直接 `importGeoJSON` 进内存，被 `buildGeoJSON` 当当前库要素写回 → 每切一次库灌一遍（跨库污染）。

**对策**：全局素材走独立 `globalGeoLayer`（`global:true`）只读预览，橙色虚线 + popup「不属于任何数据库」。`renderLayerList` 的「当前库共 N 个要素」已排除 `global` 图层。入库唯一路径 = 用户点「入库」按钮 → `importGlobalGeoToDb()` 二次确认。详见 ARCHITECTURE §6.1。

---

## 9. 切库后旧图层不消失 / 内存快照写进新库

**现象**：切到 B 库后地图上还画着 A 库的要素，或 B 库出现了 A 库的数据。

**根因**：`switchDb` 没做全四步——只切了下拉没清图层/没停自动保存，2 秒后把 A 库内存快照写进了 B 库。

**对策**：切库必须四步齐全（ARCHITECTURE §6）：`clearTimeout(autoSaveTimer)`+`_dbLoaded=false` → `clearFeatureLayers()` 真 `removeLayer` → `await autoLoad()` → `renderAll()`。

---

## 10. /save-geodata 空提交把整库清空

**现象**：保存时空提交（无要素），整张 features 表被清空，且不可恢复。

**根因**：旧逻辑「先清库再全量写」，内存快照不完整时就抹掉整库（曾真实丢过一次 trip 数据）。

**对策**：现空提交返回 `skipped`，整表覆盖必须显式 `?mode=replace`；删除走 payload 的 `deleted:[clientId]` 精确删。前端 `saveToServer` 严禁「先清库再全量写」模式。

---

## 11. `ss` / `netstat` 读不到监听端口

**现象**：`ss -ltn` 只有表头，看不到任何监听套接字，误以为服务没起。

**根因**：termux 上 `ss` 读不到监听套接字（已知不可靠）。

**对策**：用 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<端口>/` 本地探活，或直接读代码里的端口分配（`grep -rn "listen("`）。别信 `ss` 的空输出。

---

## 12. DMChat 登不上去

**现象**：打开 `http://192.168.1.21:8083` 是登录页，但登录总失败 / 没有可用账号。

**根因**：DMChat 是**注册制**，没有预置固定密码。设备当前若无 `users.json` 则无账号；有账号但密码错也登不上。账号文件 `users.json`/`invites.json` 是运行时数据（gitignore），clone 到新机需重新注册。

**对策**：首次访问点「注册」，用有效邀请码（设备上当前管理员邀请码为 `adminc50gch`，已用；新用户需在 DMChat 内生成新邀请码）。第一个注册者自动成为 admin。**不要在公开仓库写明文密码/邀请码**。

---

## 13. 登录 shell 刷 PM2 报错 / `host metrics` 行

**现象**：每次开 termux 都 `[PM2][ERROR] Failed to read dump file`、`No processes saved`、空进程表、一行 `host metrics`。

**根因**：`~/.bashrc` 有 `pm2 resurrect`，但 PM2 的 `dump.pm2` 早丢、守护进程空转。PM2 是废弃方案的残留。

**对策**：已从 `~/.bashrc` 移除 `pm2 resurrect` 并 `pm2 kill` 停守护进程。登录 banner 现在干净、端口准确。**严禁再用 pm2/nohup 自启 DM 服务**——只用 runit。详见 ARCHITECTURE §9。

---

## 14. 重装后 `sv up` 全 fail

**现象**：设备重启/被 kill 后 `sv up dm-*` 全部 `fail`。

**根因**：`runsvdir` 没在运行（设备重启或进程被回收后不会自动拉起）。

**对策**：先拉起 runsvdir 再 `sv up`：
```bash
setsid $PREFIX/bin/runsvdir -P $PREFIX/var/service &
sv up dm-DMcore   # 逐个或循环 up
```

---

## 15. 端口冲突（两服务同端口）

**现象**：某服务起不来，日志报 `EADDRINUSE`，但 `pgrep` 找不到游离 node（冲突方是另一个 dm-*）。

**根因**：`config.json` / `resolve_port` 把两个服务配到同一端口。

**对策**：改根目录 `config.json` 或对应 `dm-manifest.json` 的端口，确保 8081~8088 + 5432 不重叠。改完 `sv restart` 对应服务。

---

## 16. 阿里底图下载被 Cloudflare 拦截 / 建空库

**现象**：`./install.sh geodata` 或 `./fetch-datav.sh` 卡住、或建出空库无数据。

**根因**：`geo.datav.aliyun.com` 被 Cloudflare 拦截（网络环境相关）。

**对策**：切换网络避开拦截后重试；或离线导入 `./install.sh geodata --local <目录>` / `./fetch-datav.sh` 走本地缓存。`fetch-datav.sh` 现已在阿里不可达时**明确报错退出（exit 2）**，不再哑错把库建空。

---

## 17. map-player.html 地图平移（拖拽）永久失效

**现象**：`/map-player.html` 一开始能拖地图，但只要在地图上按下/拖动过任意 marker（照片、视频、普通点），地图就再也拖不动了。

**根因**：`addPhotoToMap` / `addVideoToMap` / `addMarker` 里 `mousedown` 都调了 `map.dragging.disable()`（拖 marker 时不想让地图跟着动），但三个 handler 的 `dragend` 里**漏了 `map.dragging.enable()`**，只有顶点编辑那条补了。于是 dragging 被关掉后永远回不来。

**对策**：已在三处 `dragend` 补 `map.dragging.enable()`，并各加 `click` 兜底（防止「按下没拖动」也卡死）。改完 `map-player.html` 刷新页面（强刷 Ctrl/Cmd+Shift+R）即可恢复。注意：这属于 Leaflet 交互细节——凡是 `mousedown` 里 `disable` 了拖拽，对应 `dragend`/`click` 必须 `enable` 回来，否则就是永久失效。

## 18. regional-stats 极慢（dashboard 加载数据多了就卡）

**现象**：`/dashboard.html` 打开时卡几十秒甚至分钟级，数据越多越慢。实测 32 个要素时单次 `GET /api/geo/regional-stats` 耗时 ~55 秒。

**根因**：`DMgeo/server.js` 的 `regional-stats` 原来是**逐要素 × 逐边界表**的 N×M 算法——对每个要素，逐个遍历 Basemap 的 provinces(~34)/cities(~340)/districts(~3000)/countries(~180)，每条发一条 `ST_Contains` SQL 往返（≈ 要素数 × 3500 次查询）。而且这些边界表**原本没有 GIST 索引**，单条查询也是顺序扫描。复杂度随要素数线性爆炸。

**对策**：已改为**空间 JOIN**——用 4 次 SQL（`stats_features` 质心 `ST_Centroid(geom)` JOIN 各边界表 `ST_Contains`）一次性算出每个要素的省/市/区县/国家归属，并在 `ensureStatsMirror()` 里给 `provinces/cities/districts/countries` 补 `USING GIST (geom)` 索引。实测同库从 ~55s 降到 ~0.07s（290×）。统计口径与原逻辑严格一致（判定点同为质心；台湾→China；境内优先省市区、否则国家；汇总过滤规则不变）。改完重启 `dm-DMgeo` 生效。**教训**：PostGIS 空间查询一定要给参与 `ST_Contains` 的几何列建 GIST 索引，且优先用 JOIN 而非「应用层逐行发 SQL」。

## 19. db-manager.html 编辑含 jsonb 列的表保存失败（✎ 编辑 bug）

**现象**：在 `db-manager.html`（8084）里，对任意含 `jsonb`/`json` 类型列的表（如 `features.properties`）点 ✎ 编辑、改完点「确认」，弹出报错 `invalid input syntax for type json`，数据保存不进去。

**根因**：编辑表单把 JS 对象 `String()` 后显示成字面量 `[object Object]`，保存时 `el.value` 取到这个字符串，后端 `PUT /rows/:id` 对字符串值拼成 `SET col = '[object Object]'`，PostgreSQL 拒绝把非法 JSON 写进 jsonb 列 → 400。**几何列（geometry）不受影响**：编辑逻辑本就跳过 geometry，且后端对 `Point` 对象走 `ST_GeomFromGeoJSON`，所以只 jsonb/json 列中招。

**对策**：前后端配套修（`DMgeo/db-manager.html` + `DMgeo/server.js`）：
- 前端 `showEdit`/`addRow`：对对象值用 `JSON.stringify` 显示；`saveEdit`/`addRow` 对 `data_type`/`udt_name` 含 `json` 的列做 `JSON.parse` 后再提交（非法 JSON 会给提示不破坏数据）；
- 后端 `PUT /rows/:id`：值若为对象且非 `Point`，用 `'<json>'::jsonb` 写入，而非 `String(v)`。
- 改完刷新页面（强刷 Ctrl/Cmd+Shift+R）即可。验证：用临时行 PUT 嵌套对象 `{"k":"v2","nested":{"a":1}}` → 查回仍是真 JSON 对象，旧逻辑复现则报 `invalid input syntax for type json`。**教训**：jsonb 列的前端编辑必须用 JSON 文本 ↔ 对象互转，后端必须用 `::jsonb` 显式转换，不能把 JS 对象当字符串拼 SQL。

---

## 20. 路径总览展开后显示坐标而非站点名

**现象**：dashboard「路径总览」展开「途经站点」里某些点只显示 `lat, lon` 坐标，没有站点名。

**原因**：站点名是按顶点坐标（lat/lon 保留 5 位小数）去匹配同库里**带 `properties.name` 的点要素**（`MultiPoint`）。手动画的线、或顶点没落在任何命名点上的，就退化显示坐标——这是**预期行为，不是 bug**。

**对策**：
- 想让线显示站点名，连线时依次点「有名字的标记」即可；或先给点位补上 `name`（标记编辑 / `db-manager.html`）。
- 切库后站点名随当前库变化（数据来自 `api/geo?db=当前库`）。
- 若整条线都无站名，说明该库的命名点要素与线顶点坐标对不上（或库里就没有命名点）。

---

## 21. 济源等省直辖县级市在建点后点亮视图"不显示"

**现象**：在某个城市（如河南济源市，adcode 419001）建了点/线，普通地图能看到，但"点亮/regional-stats 统计"视图里这个市整体消失，点也不计入。

**原因**：省直辖县级市在 `Basemap.districts` 表里**没有区级多边形**（DataV 只给到 city 级）。点亮聚合时，落不进任何区的点被归入 `海外/未知` 区；而旧逻辑算"城市总数"只累加**非海外/未知区**的点 → 这些市 cityTotal=0 → 整市被 `continue` 剔除。边界数据没丢、点也存得好好的，是被聚合逻辑藏了。

**对策**：
- 已修复（commit e4b6f52）：城市总数/点数改按"全市点（含未知区）"计算，仅列表不展示 `海外/未知` 区。修复后重启 DMgeo 即生效。
- 验证：`curl 127.0.0.1:8084/api/geo/regional-stats?db=trip | python3 -m json.tool` → 看对应省下是否出现该市、`total` 是否含这些点。
- 想给济源补区级下钻：用 `fetch-datav.js` 拉 419001 的 `_full.json` 把区导入 `districts` 即可（非必须，修复后无区也能显示）。

---

## 22. npm install 报 `Refusing to fetch "http://mirrors.tencent.com/npm/..."`

**现象**：新机 `install.sh apps` 时 DMgeo / DMChat 依赖装失败，`geodata` 阶段因 DMgeo 缺 `pg` 包整个跳过；日志里是 `npm error Fetching packages of type "remote" have been disabled` / `Refusing to fetch "ws@http://mirrors.tencent.com/npm/ws/-/ws-8.21.0.tgz"`。

**原因**：`DMChat/package-lock.json` / `DMgeo/package-lock.json` 里 `resolved` 字段硬编码了旧的腾讯镜像 http tarball 地址。npm 12 的安全策略拒绝从非当前 registry 的 "remote" tarball 拉取。这不是"换源"问题——设备 registry 本就是官方源，是 lock 文件残留。

**对策**：把两个 lock 文件里的 `http://mirrors.tencent.com/npm/` 全部替换为 `https://registry.npmjs.org/`（已修复并提交）。之后 `npm install` 正常。判别：`grep -rl mirrors.tencent.com --include=package-lock.json .` 应无输出。

---

## 23. 新机部署后 `/api/geo` 报 `permission denied for table features`

**现象**：服务全部 up、端口 200，但 `curl '127.0.0.1:8084/api/geo?db=trip'` 返回 500 `{"error":"permission denied for table features"}`，地图不显示要素。

**原因**：termux 宿主 initdb 后，建库/建表用的是当前 unix 用户（超级用户，如 `u0_a218`），`features` 等表 owner 是它。`dmuser` 虽是数据库 OWNER，但**库内新建表的默认 owner 是建表者**，dmuser 对表无权限。这是第 6 条"重置 PG 后授权"在新机部署场景的具体表现。

**对策**：`02-postgis.sh` 建表后已加入幂等授权段（对 trip/Basemap/dmpageo 三库 `GRANT ALL ON ALL TABLES/SEQUENCES` + `ALTER DEFAULT PRIVILEGES ... TO dmuser`），新机部署自动完成。已部署的机器若漏了，手动重跑该授权段即可（见脚本），无需重建库。验证：`PGPASSWORD=dmpageo123 psql -h 127.0.0.1 -U dmuser -d trip -tAc 'select count(*) from features'` 应返回数字而非权限错误。


## 24. 新机（红魔5G）部署全套踩坑与正解（2026-11-20）

从零给红魔5G（骁龙865 / Android / u0_a208）部署 dm-family，一次跑通，记录几个非显然的坑：

1. **Termux 下载链接别下错**：GitHub Packages 的 `com.termux.termux-shared` 是开发者依赖库（.aar/.jar），不是可安装 APK。正解是 GitHub Releases `termux/termux-app` → v0.118.3 稳定版 `..._arm64-v8a.apk`。

2. **`dpkg was interrupted, run 'dpkg --configure -a'`**：`pkg update/upgrade` 中途被打断（锁屏/切后台/网络断）后 dpkg 锁死，之后所有 pkg 命令都拒绝执行。先 `dpkg --configure -a` 解锁，再重跑安装。

3. **apt / pip 双源都要换**：国内网络下 Termux apt 官方源慢 → `termux-change-repo` 选上海交大/清华；Python 侧 venv 里 `pip install -U pip` 会卡官方 PyPI → 先配 `~/.config/pip/pip.conf`：
   ```
   [global]
   index-url = https://pypi.tuna.tsinghua.edu.cn/simple
   trusted-host = pypi.tuna.tsinghua.edu.cn
   timeout = 60
   ```
   不配的话 `install.sh dm` 会永远卡在"在 venv 中安装 DMcore 依赖"，看似无输出实则等网络。

4. **设备端 GitHub 443 不可达 → 无法 clone**：红魔 `git clone` 走不通（但 raw.githubusercontent.com 可达）。用本机 `tar --exclude` 打包带 `.git` 仓库 → `scp` → 设备端解压，再跑 `./install.sh`，等价重建。详见 README「在 Termux 一键部署」。

5. **adb 不是最省事的路**：本机 winget 装 platform-tools 报 `Installer hash does not match`；直下官方 zip 可解。但 USB adb 需管理员权限装驱动（VID_12D1 是华为/荣耀，红魔是 18A1/05C6；当时误插荣耀9i），无线 adb 要在开发者选项手动开。**结论：Termux `pkg install openssh && sshd` + 网络 SSH 才是一劳永逸的通道**，本机配 `Host redmagic` 别名密钥免密。

6. **验证不能只看 HTTP 200**：`curl /` 返回 200 只说明服务进程活着，还要验 `/api/geo?db=trip` 返回合法 GeoJSON（验证 PG 授权，见第 23 条），且 DMChat 的 8443 要用 `https://` 探（`curl -sk ...:8443/` 应 200，证书由 dmcore-start.sh 自愈生成）。

7. **cities 数 475 vs 汇总 587**：`geodata` 日志里"市(含区) 587"是汇总口径，入库 `Basemap.cities` 实际 475 市（+districts 2840）；这是去重后的正常值，与跑了很久的主力设备完全一致，不是数据丢失。dmpageo 库无 `features` 表属正常（它只存 countries 世界国界）。

8. **`sv status` 报 usage / "file does not exist"**：termux 下 `$SVDIR` 为空，必须显式指定：`SVDIR=$PREFIX/var/service $PREFIX/bin/sv status dm-DMcore`；服务名 `dm-DMChat` 是大写 C，写错会报 "unable to change to service directory"。`sv status` 不带服务名会打印 usage（正常）。

## 25. 从本机 tar 推送代码到已部署设备时，会冲掉设备的 serverId（联邦网盘身份漂移）

**现象**：用本机 `tar` 打包 → `scp` → 设备端解压更新代码后，8087「🌐 全网」里这台设备**身份变了**——其它设备按旧 serverId 登记的 remote 失效，得重新握手。表面看服务全正常、端口 200，很难察觉。

**原因**：`DMmedia/storage-config.json` 是**受版本控制**的文件（`git ls-files` 能看到），里面的 `serverId` 字段却由每台设备**运行期自动生成**：`DMmedia/server.js` 启动时会检查 `serverId`，若为空就 `generateId()` 生成并写回文件（第 43-55 行）。

- 本机 / GitHub 仓库里的 `storage-config.json` → `"serverId": ""`（空）
- 设备实际跑起来后 → `"serverId": "3d2f1bde-..."`（各自的 UUID）

用本机打包覆盖推送，会把设备上的 UUID 冲成空字符串；服务重启后**重新生成一个新 UUID**——于是联邦网盘里这台的 ID 变了，别人登记的旧 ID 指向一个不存在的设备。`remotes` 字段同理（握手记录在设备端，覆盖会清空）。

**正确姿势（二选一）**：

1. **打包时排除**（推荐，最省事）——本机 tar 命令加两个 `--exclude`：
   ```bash
   tar --exclude='.workbuddy' --exclude='node_modules' \
       --exclude='DMmedia/storage-config.json' \
       --exclude='DMmedia/album' --exclude='DMmedia/music' \
       --exclude='DMmedia/video' --exclude='DMmedia/tvdrama' \
       -czf ~/dm-repo.tar.gz Dmhometermux
   ```
   设备端解压时不会碰原 `storage-config.json`，serverId / remotes 原样保留。**新机首次部署不能排除**（需要仓库里的初始配置）。

2. **推送后还原**——设备端先在推送前备份，解压后覆盖回去：
   ```bash
   cp ~/Dmhometermux/DMmedia/storage-config.json ~/storage-config.bak.json
   # ...解压更新代码...
   cp ~/storage-config.bak.json ~/Dmhometermux/DMmedia/storage-config.json
   ```

**验证**：推送前后在设备上看 `grep serverId ~/Dmhometermux/DMmedia/storage-config.json`，UUID 应保持不变；`curl -s http://127.0.0.1:8087/api/info` 里的 `serverId` 也应一致。

**同理适用**：任何"设备运行期会写回、且被 git 跟踪"的配置文件，覆盖式推送前都要先想清楚——不只是 serverId。判断方法：`git status` 在设备上显示 `M` 的文件，就是被运行期改过的，推送时别让本机版本盖掉。

## 26. 新机部署后音乐/视频/网盘全空：媒体目录从未被创建（2026-11-21）

**现象**：dm-family 装完、所有端口 200，但 8081 音乐/视频/TV 剧/相册是空的，8087 网盘里也没有 `music`/`video`/`album`/`pdf` 等文件夹。红魔新机和跑了很久的主力机都复现。

**根因**：`DMmedia/storage-config.json` 定义了 8 个媒体路径（`./music` `./video` `./tvdrama` `./album` `./book` `./pdf` `./Audio` `./geodata`），`server.js` 启动后按这些路径扫描媒体；但这些**目录本身被 `.gitignore` 忽略、安装脚本也从未创建**（历史遗留）。主力机靠 `file-shortcuts.json` 快捷方式指向别处才一直没暴露，新机没快捷方式就直接全空。

**修复**：
1. 已改 `install/03-apps.sh`：apps 阶段从 `storage-config.json` 的 `paths.*.dir` 读取并 `mkdir -p` 建齐所有媒体目录（跳过绝对路径残留、幂等、node 实现）。新机部署不会再漏。
2. 已部署设备补建（无需重启服务，scanWithCache 会随目录出现重新扫到）：
   - 能通过 8087 网页接口建：`POST http://<设备>:8087/api/mkdir`，body `{"parent":"<DMmedia绝对路径>","name":"music"}`，8 个目录逐个建。
   - 或 SSH：`cd ~/Dmhometermux/DMmedia && mkdir -p music video tvdrama album book pdf Audio geodata`。

**验证**：`curl http://<设备>:8087/api/list?path=music` 返回 `{"current":".../DMmedia/music",...}` 即目录就位；放媒体文件进去后 `curl http://<设备>:8081/music-list.json` 应返回对应条目。

**同理**：DMshow 素材库 `library/{works,albums,videos,gallery}` 由 03-apps.sh 显式建，不受此问题影响。

## 27. 双向握手后音乐/媒体没合并：递归拉取 4 秒超时互相降级（2026-11-21）

**现象**：两台设备各自握手成功后 `GET /api/remotes` 都显示 `online:true`，但 `/music-list.json` 只返回本机列表，对方的音乐死活合并不过来；每个聚合请求恰好耗时 **4.0 秒**。

**根因**：握手是单向登记（见前），双向可见需在两台各握手一次。但 `respondAggregated()` 拉远端时请求对方的 `music-list.json`（本身也是聚合端点），于是 A 拉 B → B 拉 A → 互相阻塞，双方都撞上 `fetchRemoteJson` 的默认 4s 超时 → 静默降级成只剩本地。表现为"握手成功但不合并"。

**诊断决定性实验**：临时 `DELETE` 掉其中一台的 remote 打破环，另一台的聚合立刻从 4s 降到 0.27s 并正确合并出对方的条目（`_remote` 字段标记来源）。

**修复**（`DMmedia/server.js`）：
1. `fetchRemoteJson()` 请求远端列表时加 `?local=1`；
2. `respondAggregated()` 增加 `localOnly` 参数，为 true 时跳过远端聚合、只返回本机列表；
3. createServer 里解析 `url.searchParams.get('local')==='1'`，传给全部 7 个 list 端点（music/book/pdf/audio/tvdrama/video/album）。

效果：对端拉到的是**纯本地**列表，递归环被打断；用户页面正常请求（不带 local）仍拿到本机+所有 remote 的聚合。`local=1` 是内部协议，不影响前端。

**部署**：改完需重启 8081 进程（`SVDIR=$PREFIX/var/service $PREFIX/bin/sv restart dm-DMmedia`）才生效。红魔 sshd 被后台回收时，可先用 8087 的 `/api/upload`（原始流，`?dir=<DMmedia绝对路径>&name=server.js`）覆盖文件——注意该接口防重名会自动改名 `server_1.js`，需先 `DELETE /api/delete` 删掉原 `server.js` 再传。**只替换 server.js，绝不动 storage-config.json**（保住 serverId 与握手记录）。

## 28. 删除媒体文件后列表残留：`getDirMtime` 只看文件 mtime 最大值（2026-11-21）

**现象**：删掉音乐/视频文件后，8081 媒体列表里仍显示该文件（残留），要过很久甚至重启才消失。断断描述"删了还有残留，好像两个似的但其实也不会"。

**根因**：`scanWithCache()` 用 `getDirMtime(dir)` 做缓存指纹，而旧版 `getDirMtime` 取的是**目录树内所有文件的最大 mtime**。删除一个**不是最新**的文件时，剩余文件的最大 mtime 完全不变 → 缓存命中 → 返回含已删条目的旧列表。删除最新文件则正常（最大值变了），所以问题间歇出现、难复现。

**修复**（`DMmedia/server.js` 的 `getDirMtime`）：
- 把每个**目录自身的 mtime** 纳入指纹（增删子项都会刷新所在目录 mtime），并累计**条目数**兜底；
- 返回值从纯数字改为 `最大mtime:条目数` 字符串（3 处缓存共用：普通媒体/tvdrama/album，都用 `===` 比较，字符串比较正常）。

效果：增删任意文件（无论新旧）都会改变指纹 → 缓存即时失效 → 列表正确刷新。实测：放一个旧 mtime 临时文件→列表+1，删除→立刻回到原数、无残留。

**复现/验证技巧**：要复现必须删"最旧"的文件；用 `touch -d '2020-01-01'` 造旧 mtime 文件最稳。注意别误删用户真实文件——本次实验误删了「龙珠之谜.mp3」，已从本机 `~/Downloads/music/` 恢复。

**关于"看起来像两个"**：同名文件若在两台设备都存在（如各存一份 `凡人tv.mp3`），聚合列表会显示两条（本机 + remote 各一），这是真实的两份文件、非重复 bug；用 `grep -o` 数文件名要注意 name 和 file 字段各出现一次，别误判成重复。

**覆盖范围（2026-11-21 两台实测）**：首页 6 个媒体入口（电视剧 / MV / 音乐 / 写真馆 / 有声书 / 阅读）对应 7 个列表端点 `music-list.json`、`video-list.json`、`tvdrama-list.json`、`album-list.json`、`audio-list.json`、`book-list.json`、`pdf-list.json`，**全部共用同一个 `getDirMtime`**（`scanWithCache` 管 5 个普通库、`scanSeriesWithCache` 管电视剧、`scanAlbumWithCache` 管写真馆），因此一次修复覆盖全部。回归测试必须造「两个文件、删较旧那个」，空目录增删验不出此 bug。荣耀9i 与红魔两台 × 7 端点逐项实测：加入 2 文件 → 删除旧文件 → 列表即时少 1 条，14/14 全通过，临时文件零残留。

**⚠️ 待办：DMgeo 有一份独立同款实现**。`DMgeo/server.js` 第 236 行的 `getDirMtime` 与旧版 DMmedia 完全一样（只取文件最大 mtime），供 `/geodata-list.json` 的 `scanGeodataWithCache()` 使用；通过 API 写要素/删要素时会 `delete cache['geodata-list']` 兜住，但**用户直接删 geodata 目录里的文件仍会残留**。全仓库仅此两处 `getDirMtime` 定义（DMshow 为实时扫描、无缓存）。按断断要求「回头再改」，暂未修改。
