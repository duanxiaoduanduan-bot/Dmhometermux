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

**现象**：浏览器打 `http://192.168.1.40:808X` 打不开。

**根因**：本机与设备不在同一网段/被防火墙隔离（多数情况其实直连可达，先验证）。

**对策**：先在本机 `curl -s -o /dev/null -w "%{http_code}" http://192.168.1.40:808X/` 验证——实测通常返回 200。仅当网段隔离时用隧道：
```bash
ssh -N -L 18084:127.0.0.1:8084 arm   # 然后本机访问 http://127.0.0.1:18084
```

---

## 4. 设备锁屏后所有端口 refused / 连不上

**现象**：能 ping 通但所有端口 refused，或 SSH 连不上。

**根因**：Android 锁屏会冻结 termux 后台（包括 sshd 和 dm-* 服务进程）。

**对策**：点亮设备 → 打开 termux 跑 `termux-wake-lock`（申请唤醒锁）；sshd 被回收则 `pkill sshd; sshd`。长期建议保持 termux 前台/加白名单。

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

**现象**：打开 `http://192.168.1.40:8083` 是登录页，但登录总失败 / 没有可用账号。

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
