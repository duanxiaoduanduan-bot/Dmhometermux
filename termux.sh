#!/usr/bin/env bash
# ============================================================
#  termux.sh — Termux / Android 一键部署（全家服务跑在 termux 宿主）
#
#  设计（2026-07 定稿，弃用 proot 方案）：
#    - PostgreSQL/PostGIS 直接用 termux 官方仓库的 postgresql + postgis 包，
#      mmap 共享内存，initdb/启动均正常（proot 的 ptrace 会让 PG 共享内存
#      初始化永久挂死，已验证 PG14/15/16 全数中招，故弃用）。
#    - 进程托管用 runit（termux-services），与 termux 官方 postgres/sshd
#      同机制：每个服务一个 runsv 实例，$PREFIX/var/service/dm-<name>/。
#    - 媒体数据留在仓库工作目录（gitignore，不进仓库、绝不删除）。
#
#  用法（在 Termux 里执行）：
#    bash termux.sh                  # 全自动：装依赖 → 复用/克隆仓库 → ./install.sh
#    bash termux.sh /path/to/repo   # 指定已存在的仓库目录（含本地媒体，复用不克隆）
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

# ── 1. 基础依赖（termux 官方仓库，非换源）──
info "确保基础依赖 (git/bash/termux-services) ..."
NEED=()
command -v git >/dev/null 2>&1 || NEED+=(git)
command -v sv  >/dev/null 2>&1 || NEED+=(termux-services)
[ "${#NEED[@]}" -gt 0 ] && pkg install -y "${NEED[@]}"

# ── 2. 定位 / 克隆仓库（含本地媒体数据，保留不删）──
if [ "$#" -ge 1 ] && [ -d "$1/.git" ]; then
  REPO_DIR="$1"; ok "复用指定仓库: $REPO_DIR"
elif [ -d "$HOME/Dmhometermux/.git" ]; then
  REPO_DIR="$HOME/Dmhometermux"; ok "复用 $REPO_DIR"
else
  REPO_DIR="$HOME/Dmhometermux"
  info "克隆仓库 → $REPO_DIR ..."
  rm -rf "$REPO_DIR" 2>/dev/null || true
  git clone "$REPO_URL" "$REPO_DIR"
fi

# 迁移提示：宿主上若仍有老的 PM2 版 DM 服务在跑，端口会冲突。
if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | grep -qiE "DMpageo|DMcore|DMgeo"; then
    warn "检测到宿主 PM2 仍在运行旧的 DM 服务，可能与此部署端口冲突。"
    warn "建议先: pm2 delete all   （媒体数据在仓库目录内，不受影响）"
  fi
fi

# ── 3. 直接在宿主跑 install.sh ──
cd "$REPO_DIR"
info "执行 ./install.sh（pkg/runit 原生，含 PG+PostGIS）..."
bash ./install.sh            # dm → postgis → apps → geodata → start

ok "部署完成。服务由 runit 托管，运行在 termux 宿主。"
info "局域网访问: http://<设备当前IP>:<端口> （IP 以实际为准，端口表见 README）。"
info "看状态: cd $REPO_DIR && ./install.sh status"
