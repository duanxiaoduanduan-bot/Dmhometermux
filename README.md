# dm-family

本地多服务家族：**DMcore 控制台** 统一发现、托管、代理各子服务（媒体、地图、聊天、作品集、网盘等）。
全家服务运行在 **Termux / Android 宿主**，由 **runit（termux-services）** 托管。

## 文档入口

| 文档 | 内容 |
|------|------|
| **[ARCHITECTURE.md](ARCHITECTURE.md)** | **各部分设计逻辑**（部署架构、数据库三库、统计口径、前端切库、服务托管、DMcore 适配、登录 shell+banner、DMmedia 转播融合） |
| **[TROUBLESHOOTING.md](TROUBLESHOOTING.md)** | **易错点 / 排坑清单**（孤儿进程、端口冲突、串库、重置 PG、休眠、PM2 残留…） |
| **[CHANGELOG.md](CHANGELOG.md)** | 近期全部改动总览（DMshow / 网盘 / 安装 / 代理） |
| [install/README.md](install/README.md) | 分阶段安装（**先装 DM**） |
| [DMcore/README.md](DMcore/README.md) | 运维控制台 |
| [DMshow/README.md](DMshow/README.md) | 作品集主页 |
| [DMshow/library/README.md](DMshow/library/README.md) | 素材库目录约定 |
| [DMmedia/FILE-MANAGER.md](DMmedia/FILE-MANAGER.md) | 网盘：传输、乱码、**新增存储介质**、API |

## 快速安装（Ubuntu / Linux）

**方式一：从 GitHub 克隆（推荐）**

```bash
git clone https://github.com/duanxiaoduanduan-bot/Dmhometermux.git dm-family
cd dm-family
chmod +x install.sh uninstall.sh sync-github.sh install/*.sh
./install.sh          # 一键全装：dm → postgis → apps → geodata → start
```

**方式二：本地目录直接装**

```bash
chmod +x install.sh install/*.sh
./install.sh dm      # 只装核心（推荐先跑）
./install.sh         # 全装（含地图底图数据，装完大屏不黑屏）
./install.sh postgis # 建 postgis 扩展（非 termux 需 root；termux 宿主直接用当前用户 initdb，无需 root）
./install.sh status
```

> 地图底图默认从**阿里 DataV.GeoAtlas + Natural Earth** 在线下载（脚本自动重试+缓存）。
> 离线/内网环境：`./install.sh geodata --local <目录>` 从 U 盘或旧机缓存导入；
> 暂不装：`SKIP_GEODATA=1 ./install.sh`，之后 `./install.sh geodata` 再补。

**卸载 / 同步**

```bash
./install.sh uninstall        # 停服务+清标记（数据全保留）
./uninstall.sh --purge        # 连构建产物一起清，回到刚 clone 状态
./uninstall.sh --all          # 彻底卸载（含数据库，需确认）

./sync-github.sh init https://github.com/duanxiaoduanduan-bot/Dmhometermux.git   # 首次关联 GitHub 并推送
./sync-github.sh "更新说明"        # 日常提交+推送（数据目录已 gitignore）
```

> 数据说明：媒体文件、`DMgeo/geodata` 地图数据、`DMshow/library` 素材**不进 Git 仓库**。
> clone 后 `./install.sh` 的 **geodata 阶段**会自动下载/导入底图数据，其余数据随使用自然积累。

## 在 Termux / Android 上部署（全家服务跑在 termux 宿主，由 runit 托管）

termux 官方仓库提供 PostgreSQL + PostGIS 包，直接在宿主安装运行（mmap 共享内存，`initdb`/启动正常）。
进程托管用 **runit（termux-services）**，与 termux 官方 postgres/sshd 同机制：每个服务一个 `runsv` 实例，目录在 `$PREFIX/var/service/dm-<name>/`。

> ⚠️ **已弃用 proot 方案**：proot 的 ptrace 会让 PostgreSQL 共享内存初始化永久挂死（PG14/15/16 均验证中招），故全家服务直接跑 termux 宿主。

```bash
# 在 Termux 里执行
pkg install -y git termux-services   # 首次基础依赖
bash termux.sh                        # 全自动：装依赖 → 复用/克隆仓库 → ./install.sh（dm→postgis→apps→geodata→start）
# 已有仓库想复用（含本地媒体）：bash termux.sh /path/to/your/repo
```

- 服务由 runit 托管，端口在局域网 `http://192.168.1.21:<端口>` 可直接访问（见下方端口表）。
- **严禁再用 PM2 / nohup 自启 DM 服务**（历史 PM2 方案已废弃并清理，`~/.bashrc` 的 `pm2 resurrect` 已移除）。DM 服务只由 runit 托管，混用会与 runit 双管理、造成孤儿进程 / 端口冲突。
- 看状态：`cd ~/Dmhometermux && ./install.sh status`，或 `sv status dm-DMcore`。

## 一键脚本（日常运维）

安装完成后（`./install.sh` 跑过一次），日常用这两个根目录脚本，不必再记 `./install.sh` 的子命令：

| 脚本 | 作用 |
|------|------|
| `./run.sh` | 一键启动全部服务（等价于 `./install.sh start`）。安装一次后日常起服务用这个。 |
| `./fetch-datav.sh` | **独立刷新阿里行政区划数据**：联网拉取阿里 DataV.GeoAtlas 最新省/市/区 → upsert 入库 → 重建底图。切换网络（避开 Cloudflare 对 `geo.datav.aliyun.com` 的拦截）后纯拉数据用这个；阿里不可达会明确报错退出（exit 2），不会再像以前那样哑错把库建空。 |

> 阿里数据也可走 `./install.sh fetch-datav`（等价于上面的脚本）。两个一键脚本都用 `bash` 调用 `install.sh`，不依赖 `install.sh` 的可执行位（Windows 提交常丢 exec bit）。

## 主要端口（默认）

| 服务 | 端口 | 代理路径（8080 统一入口） |
|------|------|----------|
| 统一入口 proxy | 8080 | — |
| DMmedia 媒体 | 8081 | `/media` |
| DMChat | 8083 | `/chat` |
| DMgeo | 8084 | `/geo` |
| DMpageo | 8085 | `/pageo` |
| DMshow | 8086 | `/show` |
| 网盘 files | 8087 | `/files` |
| DMcore 控制台 | 8088 | — |

集中改端口：根目录 `config.json`；代理路由：`DMcore/routes.json`。

## 子服务一览

- **DMcore** — 进程/项目管理 + 统一反向代理（8080 入口 / 8088 控制台）
- **DMmedia** — 媒体播放 + **网盘**（`:8087`，双进程 server.js + file-manager.js）；**6 个播放器**（电视剧/MV/音乐/相册/书籍/音频）均支持按名称搜索、localStorage 续播（打开自动定位上次进度，不自动播放）；支持**多机转播融合**（见下）
- **DMgeo** — 地图 / PostGIS
- **DMpageo** — 合并门户（顶部 6 tab：媒体 8081 / 聊天 8083 / 地理 8084 / 主页 8086 / 网盘 8087 / 控制台 8088，iframe 聚合）
- **DMChat** — WebSocket 聊天（注册制）；聊天记录按月落盘（`chatlogs/YYYY-MM/`），📜「记录」面板可查日期/明细/导出 TXT，入群自动加载当日历史
- **DMshow** — **作品集**（`library/` 自动排版）
- **dm-postgis** — 原生 PostgreSQL 18 / PostGIS 3.6（端口 5432）

## DMmedia 转播融合（多机媒体联合）

把另一台 DM 服务器的媒体目录合并进来统一展示——**不搬文件、不建中心节点**，任何一台关机其余照常。

**入口**：`http://<设备IP>:8081` 首页顶部工具栏「🛰️ 转播」按钮 → `remotes.html` 管理页。

| 操作 | 做法 |
|------|------|
| 添加设备 | 在「添加转播服务器」填对方地址（如 `http://192.168.1.x:8081`）+ 备注名 → 点「握手」（先验证对方 `/api/hello` 拿到 `serverId` 才登记，显式信任） |
| 移除设备 | 「已配转播服务器」列表里点该台右侧 **✕** |
| 一键重连 | 管理页顶部「🔄 一键重连」 |
| 在线状态 | 列表直接显示在线/离线；对方关机自动只剩本机目录 |

> **没有「自动扫描附近设备」按钮**——添加靠手动输地址 + 握手。后台 UDP 18081 心跳只做一件事：已握手设备 DHCP 变 IP 时自动修正地址，**绝不会自动添加陌生服务器**（当初拍板的安全边界）。

合并后远端条目与本机条目长得一样（路径改写为 `remote/<id>/原路径`），6 个播放器零改动照常读列表、照常播，**远端内容天然可搜**。机制细节见 [ARCHITECTURE §12](ARCHITECTURE.md)。

### 联邦网盘（跨设备文件聚合）

网盘（`:8087`）也有全网视图：**顶栏「🌐 全网」** 聚合所有已握手设备的文件，按设备分栏浏览、勾选后跨设备下载。**设备来源就是上面转播融合的 `remotes`**——同一份 `storage-config.json`，在 🛰️ 转播页握手添加的设备自动出现在全网视图里，离线设备置灰跳过。

- 浏览远端目录、下载、校验、Range 续传、打包下载全部经本机 `8087` 反代到设备（前端零配置，复用已有的 SHA-256 校验 + 断点续传）。
- 选中文件按设备分组打包（不同设备各自成一个 ZIP，带 SHA-256 清单）。
- 远端网盘端口默认与本机相同（全家 8087）；非常规端口可在 remote 项写 `"filePort": 8089` 或 `"fileBase": "http://ip:端口"`。
- 只认已登记设备 id，不接受任意 URL（防 SSRF）。详见 [FILE-MANAGER.md](DMmedia/FILE-MANAGER.md)。

## DMChat 账号（注册制）

DMChat 是**注册制**，没有预置固定密码：

- 首次启动若没有邀请码，会自动生成 `admin` 前缀邀请码；**第一个注册的用户自动成为管理员**。
- 账号数据 `DMChat/users.json` / `DMChat/invites.json` 是**运行时数据，已 gitignore**，不进仓库——clone 到新机需重新注册（首个注册者为 admin）。
- 设备 IP 会因 DHCP 变动，以实际为准（当前 `192.168.1.21`）。**首个到新机注册的用户即为管理员**；后续在 DMChat 内生成新邀请码。不要在公开仓库写明文密码 / 邀请码。

## 设计逻辑与排坑

- 各部分**设计逻辑**见 [ARCHITECTURE.md](ARCHITECTURE.md)
- **易错点 / 排坑**见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

更细的改动说明请看 **[CHANGELOG.md](CHANGELOG.md)**。
