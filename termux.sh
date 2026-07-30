#!/usr/bin/env bash
# ============================================================
#  termux.sh — Termux / Android 一键部署（全家服务跑在 proot Ubuntu 内）
#
#  设计：termux 宿主只负责两件事——
#    1) 装 proot-distro + Ubuntu（你已有的 ubuntu-rootfs 直接复用）
#    2) 把本机仓库目录 bind 挂载进 Ubuntu，然后 `./install.sh` 在 Ubuntu 内
#       全程用 apt / pg_ctlcluster / supervisord 原生跑（PG+PostGIS 一并装好）
#  媒体数据留在宿主工作目录（gitignore，不会被删、不进仓库）。
#  proot 与宿主共享网络，所以服务监听的端口在局域网 192.168.1.38:<port> 可直接访问。
#
#  用法（在 Termux 里执行）：
#    bash termux.sh                  # 全自动：装 Ubuntu → 复用/克隆仓库 → 进 Ubuntu 跑 install.sh
#    bash termux.sh /path/to/repo   # 指定已存在的仓库目录（含本地媒体，复用不克隆）
#    bash termux.sh --reinstall     # 重建 Ubuntu 内依赖（保留宿主媒体数据）
# ============================================================
set -euo pipefail

info(){ echo -e "\033[1;36m[termux]\033[0m $*"; }
ok()  { echo -e "\033[1;32m[  ok  ]\033[0m $*"; }
warn(){ echo -e "\033[1;33m[ warn ]\033[0m $*" >&2; }
err() { echo -e "\033[1;31m[error ]\033[0m $*" >&2; exit 1; }

REPO_URL="https://github.com/duanxiaoduanduan-bot/Dmhometermux.git"

# ── 0. 必须在 termux 内运行 ──
if [ -z "${PREFIX:-}" ] || [[ "${PREFIX}" != *com.termux* ]]; then
  err "本脚本只能在 Termux 内运行（未检测到 termux 环境 PREFIX）。"
fi

REINSTALL=0
if [ "${1:-}" = "--reinstall" ]; then REINSTALL=1; shift || true; fi

# ── 1. 宿主侧：proot-distro ──
info "确保 proot-distro ..."
command -v proot-distro >/dev/null 2>&1 || pkg install -y proot-distro

# ── 2. 宿主侧：Ubuntu(proot) 已存在则复用 ──
if [ ! -d "$HOME/ubuntu-rootfs" ]; then
  info "首次安装 Ubuntu(proot)，需下载数百 MB，请耐心 ..."
  proot-distro install ubuntu
else
  ok "Ubuntu(proot) 已存在，复用"
fi

# ── 3. 宿主侧：定位 / 克隆仓库（含本地媒体数据，保留不删）──
if [ "$#" -ge 1 ] && [ -d "$1/.git" ]; then
  REPO_DIR="$1"; ok "复用指定仓库: $REPO_DIR"
elif [ -d "$HOME/Dmhometermux/.git" ]; then
  REPO_DIR="$HOME/Dmhometermux"; ok "复用 $REPO_DIR"
else
  # 优先定位含 .git 的仓库根；旧的无 git 目录（如 tar 搬运的）会被下面的 clone 分支覆盖清理
  REPO_DIR="$(find "$HOME" -maxdepth 4 -type d -name .git 2>/dev/null | head -1 | xargs -r dirname 2>/dev/null || true)"
  if [ -n "$REPO_DIR" ] && [ -f "$REPO_DIR/config.json" ]; then
    ok "自动找到 git 仓库: $REPO_DIR"
  else
    REPO_DIR="$HOME/Dmhometermux"
    info "克隆仓库 → $REPO_DIR ..."
    rm -rf "$REPO_DIR" 2>/dev/null || true
    git clone "$REPO_URL" "$REPO_DIR"
  fi
fi

# 迁移提示：宿主上若仍有老的 PM2 版 DM 服务在跑，端口会冲突。
if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | grep -qiE "DMpageo|DMcore|DMgeo"; then
    warn "检测到宿主 PM2 仍在运行旧的 DM 服务，可能与此部署端口冲突。"
    warn "建议先: pm2 delete all   （媒体数据在仓库目录内，不受影响）"
  fi
fi

# ── 4. 进 Ubuntu(proot)，bind 挂载仓库，跑安装 + 启动 ──
# 清理可能残留的卡死 initdb / 旧后台安装进程（proot 下 initdb 易挂死占坑）
pkill -9 -f 'initdb' 2>/dev/null || true
pkill -9 -f '02-postgis' 2>/dev/null || true
pkill -9 -f 'install.sh' 2>/dev/null || true
info "进入 Ubuntu(proot) 执行 ./install.sh（apt/supervisord 原生，含 PG+PostGIS）..."
proot-distro login ubuntu --bind "$REPO_DIR:/dm" -- bash -c '
  set -e
  export DM_PROOT=1
  export DEBIAN_FRONTEND=noninteractive
  # proot 内再保险清一次卡死 initdb
  pkill -9 initdb 2>/dev/null || true
  # 基础依赖先行（proot 最小镜像可能缺 ca-certificates/git/curl）
  apt-get update -qq 2>/dev/null || true
  apt-get install -y -qq ca-certificates git curl 2>/dev/null || true
  cd /dm
  ./install.sh            # dm → postgis → apps → geodata → start
'
ok "部署完成。服务在 Ubuntu(proot) 内运行，与宿主共享网络。"
info "局域网访问: http://192.168.1.38:<端口> （端口表见 README）。"
info "宿主看状态: proot-distro login ubuntu --bind $REPO_DIR:/dm -- bash -c \"cd /dm && ./install.sh status\""
