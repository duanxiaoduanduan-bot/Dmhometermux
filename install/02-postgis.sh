#!/usr/bin/env bash
# 02-postgis.sh — PostgreSQL + PostGIS + 库表（termux 宿主方案）
#
# 方案：全家服务跑 termux 宿主（不再进 proot）。
#   - PostgreSQL/PostGIS 用 termux 官方源直接装（postgresql + postgis，当前 18.x + 3.x）。
#   - initdb 以当前 termux 用户直接跑，共享内存自动走 mmap（termux 宿主无 /dev/shm，PG 回退 mmap），
#     已实测可完整 initdb / 启动 / CREATE EXTENSION postgis。
#   - supervisord 在 termux 全环境无硬链接（os.link 失败）不可用，改用 termux 原生 runit 托管：
#     注册 $PREFIX/var/service/dm-postgis/run，并禁用 termux 自带 postgres 服务避免抢占 5432。
#   - termux 下 psql 默认连库名=当前用户名，故管理命令显式 -d postgres。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

# termux 下非交互 SSH 中 $PREFIX 可能为空，显式兜底
export PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

step "安装 PostGIS / 空间库 (termux 宿主)"

PGVER="$(detect_pgver)"
info "PostgreSQL 目标版本: $PGVER"

if is_termux; then
  # termux 宿主：用 pkg 装 postgresql + postgis（termux 官方源，非换源）
  if ! have psql; then
    info "安装 PostgreSQL + PostGIS (termux) ..."
    pkg_install postgresql postgis || error "PostgreSQL/PostGIS 安装失败"
  else
    ok "PostgreSQL 已安装"
  fi
else
  # 非 termux（标准 Linux 兼容分支，保留但不推荐使用）
  if ! have psql; then
    run_apt update -qq
    run_apt install -y "postgresql-${PGVER}" "postgresql-${PGVER}-postgis-3" || error "PostgreSQL/PostGIS 安装失败"
  fi
fi

PGDATA="$PREFIX/var/lib/postgresql"
mkdir -p "$PREFIX/var/run/postgresql" 2>/dev/null || true

# SV_DIR 由 common.sh 定义（$PREFIX/var/service）
# 关键：先禁用 termux 自带 postgres 服务，避免它在 initdb 后自动拉起抢占 PGDATA / 5432
if [ -d "$SV_DIR/postgres" ]; then
  touch "$SV_DIR/postgres/down" 2>/dev/null || true
  # 服务没在跑时 sv down 会报 runsv not running，属正常噪音，屏蔽即可
  sv down "$SV_DIR/postgres" >/dev/null 2>&1 || true
fi

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  info "初始化集群 (initdb, mmap 共享内存) ..."
  rm -rf "$PGDATA"
  initdb --no-sync --locale=C -D "$PGDATA" 2>&1 | tail -15
else
  ok "集群已存在，跳过 initdb"
fi

# 注册 dm-postgis runit 服务（前台由 runit 托管：崩溃/重启自动拉起，绕开 supervisord 死路）
info "注册 PostgreSQL 为 runit 服务 ..."
mkdir -p "$SV_DIR/dm-postgis"
cat > "$SV_DIR/dm-postgis/run" <<RUN
#!/bin/sh
exec postgres -D $PGDATA -c dynamic_shared_memory_type=mmap -c listen_addresses=localhost -p 5432
RUN
chmod +x "$SV_DIR/dm-postgis/run"
# 日志由 svlogd 落盘，便于起不来时排查
mkdir -p "$SV_DIR/dm-postgis/log" "$PREFIX/var/log/sv/dm-postgis"
cat > "$SV_DIR/dm-postgis/log/run" <<LOGRUN
#!/bin/sh
exec svlogd -tt $PREFIX/var/log/sv/dm-postgis
LOGRUN
chmod +x "$SV_DIR/dm-postgis/log/run"

# 若 PG 未在跑却残留锁文件（上次非正常退出），清掉否则新实例起不来
if ! pg_isready -q 2>/dev/null; then
  rm -f "$PGDATA/postmaster.pid" "$PGDATA/postmaster.opts" 2>/dev/null || true
fi
# runit_up 兼容两种情形：runsvdir 在跑 → 等它派生 runsv；不在 → 自己起 runsv
runit_up dm-postgis
sleep 2

# 轮询等待 PG 就绪（unix socket，默认 $PREFIX/tmp）
for i in $(seq 1 20); do
  if pg_isready -q 2>/dev/null; then ok "PostgreSQL 已就绪"; break; fi
  sleep 1
done
pg_isready -q 2>/dev/null || error "PostgreSQL 未能就绪（pg_isready 失败）"

# 管理操作以当前用户(unix socket, 超级用户)连 postgres 库，避开密码/网络差异
info "创建角色: $PGUSER ..."
psql -d postgres -v ON_ERROR_STOP=0 -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='$PGUSER') THEN CREATE ROLE $PGUSER LOGIN PASSWORD '$PGPASS' CREATEDB; END IF; END \$\$;" 2>/dev/null \
  || warn "创建角色失败（可能已存在）"

for db in trip Basemap dmpageo; do
  info "确保库: $db"
  psql -d postgres -v ON_ERROR_STOP=0 -c "CREATE DATABASE \"$db\" OWNER $PGUSER" 2>/dev/null || true
  # postgis 扩展只能由超级用户创建。$PGUSER 仅 CREATEDB 非超级用户，CREATE EXTENSION 必失败，
  # 之前被 2>/dev/null 静默吞掉 → 建库"成功"但空间表/geometry 全挂。改用超级用户直连创建。
  info "  postgis 扩展 → $db (需超级用户)"
  psql -d "$db" -v ON_ERROR_STOP=0 -c "CREATE EXTENSION IF NOT EXISTS postgis;" 2>/dev/null \
    || error "postgis 扩展创建失败: $db"
done

info "创建 features 表 ..."
for db in trip Basemap; do
  psql -d "$db" -v ON_ERROR_STOP=0 -c "
    CREATE TABLE IF NOT EXISTS features (
      id SERIAL PRIMARY KEY,
      name TEXT,
      type TEXT DEFAULT 'point',
      geom geometry(Geometry,4326),
      properties JSONB DEFAULT '{}',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_features_geom ON features USING GIST (geom);
  " 2>/dev/null || true
done

# ── 结果校验：库必须真实存在且可连，否则失败（不假完成）──
VERIFY=$(psql -d Basemap -tA -c "SELECT count(*) FROM pg_extension WHERE extname='postgis'" 2>/dev/null || echo "CONN_FAIL")
if [ "$VERIFY" != "1" ]; then
  error "校验失败：Basemap 库连不上或 postgis 扩展缺失（上面步骤的失败被容错吞掉了）。"
fi

info "runit 托管状态:"
sv status "$SV_DIR/dm-postgis" 2>&1 | head || true

mark_done "postgis"
ok "PostGIS 阶段完成（Basemap + postgis 扩展已验证，PG 交由 termux runit 托管）"
