#!/usr/bin/env bash
# install/common.sh — 各安装阶段共用
# shellcheck disable=SC2034

set -euo pipefail

# 由 install.sh 注入；单独 source 时自动推断
if [ -z "${ROOT:-}" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
export ROOT
INSTALL_DIR="${INSTALL_DIR:-$ROOT/install}"
SUP_DIR="${SUP_DIR:-$ROOT/DMcore/supervisor}"
SUP_CONF="${SUP_CONF:-$SUP_DIR/supervisord.conf}"
MARKER_DIR="${MARKER_DIR:-$ROOT/.dm-install}"

PGUSER="${PGUSER:-dmuser}"
PGPASS="${PGPASS:-dmpageo123}"

# ── 日志 ──
info()  { echo -e "\033[1;36m[install]\033[0m $*"; }
ok()    { echo -e "\033[1;32m[  ok  ]\033[0m $*"; }
warn()  { echo -e "\033[1;33m[ warn ]\033[0m $*" >&2; }
error() { echo -e "\033[1;31m[error ]\033[0m $*" >&2; exit 1; }
step()  { echo ""; echo -e "\033[1;35m▶ $*\033[0m"; echo "----------------------------------------"; }

have() { command -v "$1" &>/dev/null; }

# ── 平台检测与包管理 ──
# termux 下 PREFIX 指向 /data/data/com.termux/files/usr；其余视为标准 Linux(Debian/Ubuntu)。
is_termux() {
  case "${PREFIX:-}" in
    */com.termux/*) return 0 ;;
  esac
  [ -d /data/data/com.termux/files/usr ] && return 0
  return 1
}

# 统一安装入口：termux → pkg；其余 → apt-get（run_apt 处理 sudo）
pkg_install() {
  if is_termux; then
    pkg install -y "$@"
  else
    run_apt install -y "$@"
  fi
}

need_root_apt() {
  # termux 用 pkg 安装，普通用户即可，无需 root/sudo
  if is_termux; then return 0; fi
  if [ "$(id -u)" -ne 0 ] && ! have sudo; then
    warn "非 root 且无 sudo，跳过 apt 安装（请手动装好依赖）"
    return 1
  fi
  return 0
}

run_apt() {
  if [ "$(id -u)" -eq 0 ]; then
    apt-get "$@"
  else
    sudo apt-get "$@"
  fi
}

mark_done() {
  mkdir -p "$MARKER_DIR"
  date -Iseconds > "$MARKER_DIR/$1.done" 2>/dev/null || date > "$MARKER_DIR/$1.done"
}

is_done() {
  [ -f "$MARKER_DIR/$1.done" ]
}

# 自动检测 PostgreSQL 主版本号
detect_pgver() {
  local v=""
  if have pg_config; then
    v=$(pg_config --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)
  fi
  if [ -z "$v" ] && have apt-cache; then
    v=$(apt-cache search '^postgresql-[0-9]+$' 2>/dev/null | grep -oE 'postgresql-[0-9]+' | grep -oE '[0-9]+' | sort -nr | head -1 || true)
  fi
  echo "${v:-16}"
}

ensure_supervisord_conf() {
  mkdir -p "$SUP_DIR/programs" "$SUP_DIR/logs"
  if [ ! -f "$SUP_CONF" ]; then
    cat > "$SUP_CONF" << SUPCONF
[unix_http_server]
file=${SUP_DIR}/supervisor.sock

[supervisord]
logfile=${SUP_DIR}/supervisord.log
pidfile=${SUP_DIR}/supervisord.pid
nodaemon=false

[rpcinterface:supervisor]
supervisor.rpcinterface_factory = supervisor.rpcinterface:make_main_rpcinterface

[supervisorctl]
serverurl=unix://${SUP_DIR}/supervisor.sock

[include]
files = ${SUP_DIR}/programs/*.conf
SUPCONF
    ok "已生成 $SUP_CONF"
  fi
}

# 按当前 ROOT 动态生成各服务的 supervisor program 配置
# （仓库里的 conf 不提交，避免写死绝对路径；换机器 clone 后由本函数重建）
write_supervisor_programs() {
  mkdir -p "$SUP_DIR/programs" "$SUP_DIR/logs"
  local node_bin base_path
  node_bin="$(command -v node 2>/dev/null || echo /usr/bin/node)"
  if is_termux; then
    base_path="${PREFIX:-/data/data/com.termux/files/usr}/bin:/system/bin:/system/xbin:/usr/bin:/bin"
  else
    base_path="/usr/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  fi

  # 服务名|目录|运行用户(supervisor user,空=随 supervisord)|额外环境变量
  # 注意：dm-postgis 必须 root——它要 su postgres / pg_ctlcluster 起 PG，
  # 非 root 且无 NOPASSWD sudo 时会失败。其余服务随 supervisord 身份即可。
  # termux 上走 runit（见 write_runit_services），PG 由 02-postgis.sh 注册为
  # runit 服务 dm-postgis，故此处（supervisord 路径）排除。
  local specs=(
    "DMmedia|DMmedia||DM_PORT=\"8081\""
    "DMgeo|DMgeo||PGHOST=\"localhost\""
    "DMpageo|DMpageo||"
    "DMChat|DMChat||"
    "DMshow|DMshow||"
    "DMcore|DMcore||DMCORE_PORT=\"8088\"|true"
  )
  if ! is_termux; then
    specs+=("dm-postgis|dm-postgis|root|DM_PORT=\"5432\"")
  fi
  local entry name dir puser extra auto
  for entry in "${specs[@]}"; do
    IFS='|' read -r name dir puser extra auto <<< "$entry"
    [ -d "$ROOT/$dir" ] || continue
    local user_line=""
    [ -n "$puser" ] && user_line=$'\n'"user=$puser"
    cat > "$SUP_DIR/programs/dm-${name}.conf" <<PROGCONF
[program:dm-${name}]
command=bash dmcore-start.sh
directory=${ROOT}/${dir}
autostart=${auto:-false}
autorestart=true
startsecs=2
startretries=3
stopsignal=INT
stopwaitsecs=10
stopasgroup=true
killasgroup=true${user_line}
stdout_logfile=${SUP_DIR}/logs/dm-${name}.log
stderr_logfile=${SUP_DIR}/logs/dm-${name}.log
redirect_stderr=true
environment=PATH="${base_path}",NODE_BIN="${node_bin}",DMCORE_HOST="0.0.0.0"${extra:+,${extra}}
PROGCONF
  done
  ok "supervisor programs 已按当前路径生成: $SUP_DIR/programs/"
}

# ── runit（termux 宿主方案）──
# termux-services 启用后会有一个 runsvdir 进程扫描 $PREFIX/var/service，
# 自动为每个子目录派生 runsv —— 这是服务"重启后自动恢复"的来源。
# 但 termux 不是 init 系统：runsvdir 只在 termux 登录 shell 加载过 termux-services
# 时才存在（刚装完包、纯 SSH 非交互场景可能没有），此时必须自己起 runsv 兜底。
# 两种情况都要兼容，见 runit_up。
SV_DIR="${SV_DIR:-${PREFIX:-/data/data/com.termux/files/usr}/var/service}"

# runsvdir 是否正在托管 $SV_DIR（决定 runsv 由它派生还是我们自己起）
runsvdir_active() {
  pgrep -f "runsvdir .*${SV_DIR}" >/dev/null 2>&1
}

# 生成各 DM 服务的 runit 服务目录（$SV_DIR/dm-<name>/run + log/run）
# dm-postgis 由 02-postgis.sh 单独注册，这里只管应用服务。
write_runit_services() {
  local node_bin base_path
  node_bin="$(command -v node 2>/dev/null || echo node)"
  base_path="${PREFIX:-/data/data/com.termux/files/usr}/bin:/system/bin:/system/xbin"
  local logroot="${PREFIX:-/data/data/com.termux/files/usr}/var/log/sv"

  # 服务名|目录|额外环境变量(export 语句)
  local specs=(
    "DMmedia|DMmedia|export DM_PORT=8081"
    "DMgeo|DMgeo|export PGHOST=localhost"
    "DMpageo|DMpageo|"
    "DMChat|DMChat|"
    "DMshow|DMshow|"
    "DMcore|DMcore|export DMCORE_PORT=8088"
  )
  local entry name dir extra svc
  for entry in "${specs[@]}"; do
    IFS='|' read -r name dir extra <<< "$entry"
    [ -d "$ROOT/$dir" ] || continue
    svc="$SV_DIR/dm-${name}"
    mkdir -p "$svc/log" "$logroot/dm-${name}"
    cat > "$svc/run" <<RUNSCRIPT
#!/bin/sh
export PATH="${base_path}"
export NODE_BIN="${node_bin}"
export DMCORE_HOST="0.0.0.0"
${extra}
cd "$ROOT/$dir" || exit 1
exec bash dmcore-start.sh 2>&1
RUNSCRIPT
    chmod +x "$svc/run"
    cat > "$svc/log/run" <<LOGSCRIPT
#!/bin/sh
exec svlogd -tt "$logroot/dm-${name}"
LOGSCRIPT
    chmod +x "$svc/log/run"
  done
  ok "runit 服务已生成: $SV_DIR/dm-*  (日志: $logroot/)"
}

# 确保某个 runit 服务有 runsv 实例托管并处于 up 状态（幂等）
runit_up() {
  local name="$1" svc="$SV_DIR/$1" i
  [ -d "$svc" ] || { warn "服务不存在: $svc"; return 1; }
  rm -f "$svc/down" 2>/dev/null || true

  if runsvdir_active; then
    # runsvdir 自动派生 runsv，但扫描是轮询（约 5s 一轮），新建目录不会立刻被接管。
    # 等 supervise/control 出现再 sv up，否则 sv 会报 "runsv not running"。
    for i in $(seq 1 20); do
      [ -S "$svc/supervise/control" ] && break
      sleep 1
    done
  elif ! pgrep -f "runsv $svc\$" >/dev/null 2>&1; then
    # 无 runsvdir（未加载 termux-services）：自己起一个 runsv 兜底
    setsid runsv "$svc" >/dev/null 2>&1 &
    sleep 2
  fi
  # sv 必须用绝对路径：termux 的 SVDIR 默认值并不指向 $PREFIX/var/service
  sv up "$svc" 2>/dev/null || true

  # 等待真正进入 run 状态（起不来时返回非 0，让调用方能感知失败）
  for i in $(seq 1 15); do
    sv status "$svc" 2>/dev/null | grep -q '^run:' && return 0
    sleep 1
  done
  return 1
}

# 停止某个 runit 服务（保留 runsv 实例，只 down 业务进程）
runit_down() {
  local svc="$SV_DIR/$1"
  [ -d "$svc" ] || return 0
  sv down "$svc" 2>/dev/null || true
}

# 所有 dm-* runit 服务状态
runit_status_all() {
  local svc
  for svc in "$SV_DIR"/dm-*; do
    [ -d "$svc" ] || continue
    sv status "$svc" 2>&1 || true
  done
}

ensure_config_json() {
  if [ ! -f "$ROOT/config.json" ]; then
    cat > "$ROOT/config.json" << 'CFGJSON'
{
  "_comment": "dm-family 端口集中配置。改这里一处，各服务启动时自动应用。",
  "DMmedia": { "media": 8081, "files": 8087 },
  "DMgeo":   { "port": 8084 },
  "DMpageo": { "port": 8085 },
  "DMChat":  { "port": 8083 },
  "DMshow":  { "port": 8086 }
}
CFGJSON
    ok "已生成 config.json"
  fi
}

# 确保 DMcore 进程在跑（控制台 + 代理）
start_dmcore_processes() {
  local host="${DMCORE_HOST:-0.0.0.0}"
  local port="${DMCORE_PORT:-8088}"
  local proxy_port
  proxy_port=$(python3 -c "import json;print(json.load(open('$ROOT/DMcore/routes.json')).get('port',8080))" 2>/dev/null || echo 8080)

  # DMcore 现已由 supervisord 托管（见 write_supervisor_programs 的 dm-DMcore，autostart=true）。
  # 若 supervisord 已在运行，控制台会由其 autostart 拉起，这里不能再 nohup，
  # 否则与 supervisor 争抢 8088 端口导致反复重启(BACKOFF)。
  if [ -S "$SUP_DIR/supervisor.sock" ]; then
    info "DMcore 由 supervisord 托管(dm-DMcore)，交由它 autostart 拉起"
    return 0
  fi

  mkdir -p /tmp
  # 控制台。判定只看端口是否监听——pgrep "python3 app.py" 会误匹配
  # 机器上其他同名项目进程，导致 DMcore 被跳过（已踩过）。
  if ! ss -tlnp 2>/dev/null | grep -qE "[:.]${port}([[:space:]]|$)"; then
    info "启动 DMcore 控制台 :${port} ..."
    # 优先使用 install 阶段自动创建的 venv python；不存在则回退系统 python3。
    # 必须 venv/bin/pip 也存在才算真正可用——python3 -m venv 失败可能残留指向系统的
    # bin/python 软链但无 pip，这种"假 venv"会隔离系统 site-packages 导致 flask 找不到。
    local py="$ROOT/venv/bin/python"
    [ -x "$py" ] && [ -x "$ROOT/venv/bin/pip" ] || py="python3"
    (
      cd "$ROOT/DMcore"
      export DMCORE_PORT="$port" DMCORE_HOST="$host"
      nohup "$py" app.py > /tmp/dmcore.log 2>&1 &
    )
    sleep 1
  fi

  # 统一入口代理
  if have node; then
    if ! ss -tlnp 2>/dev/null | grep -qE "[:.]${proxy_port}([[:space:]]|$)"; then
      info "启动统一入口代理 :${proxy_port} ..."
      (
        cd "$ROOT/DMcore"
        nohup node proxy.js > /tmp/dmcore-proxy.log 2>&1 &
      )
      sleep 1
    fi
  else
    warn "未找到 node，跳过 proxy.js（统一入口 :${proxy_port} 不可用）"
  fi
}

print_dm_banner() {
  local port="${DMCORE_PORT:-8088}"
  local proxy_port
  proxy_port=$(python3 -c "import json;print(json.load(open('$ROOT/DMcore/routes.json')).get('port',8080))" 2>/dev/null || echo 8080)
  echo ""
  echo "================================================"
  echo "  ✅ DM 核心已就绪"
  echo "================================================"
  echo "  🖥️  DMcore 控制台: http://127.0.0.1:${port}"
  echo "  🌐 统一入口代理:   http://127.0.0.1:${proxy_port}"
  echo "     /media /geo /pageo /chat /show /files"
  echo "================================================"
}
