#!/usr/bin/env bash
# DMmedia 启动：媒体主服务 + 网盘 | 端口来源: config.json > env > 空闲探测
set -e
cd "$(dirname "$0")"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_BIN="${NODE_BIN:-node}"

source "$ROOT/common/ports.sh"
export PORT=$(resolve_port DMmedia media 8081)
export FILE_PORT=$(resolve_port DMmedia files 8087)

echo "[DMmedia] 媒体: $PORT  网盘: $FILE_PORT"

node -e "
const fs=require('fs'),path=require('path');
const f=path.join('$ROOT','ports.json');
let d={}; try{d=JSON.parse(fs.readFileSync(f,'utf8'))}catch(e){}
d['DMmedia']={media:Number(process.env.PORT),files:Number(process.env.FILE_PORT)};
fs.writeFileSync(f,JSON.stringify(d,null,2));
" 2>/dev/null || true

# 本服务要跑两个 node，无法像其它服务那样 exec。目的相同：让 `sv restart` / `sv down`
# 能真正终止两个 node，不留孤儿占着 $PORT/$FILE_PORT —— 否则新进程起不来，
# 表现为"改了代码却没生效"。
# 旧写法 `trap 'kill 0'` 是在两个 & 之后才注册的（存在竞态窗口），且 kill 0 依赖
# 进程组假设；这里改为显式记录 PID、先注册 trap 再启动、超时兜底 KILL。
SRV_PID=""; FM_PID=""
shutdown_children() {
  trap - TERM INT EXIT
  [ -n "$SRV_PID" ] && kill -TERM "$SRV_PID" 2>/dev/null
  [ -n "$FM_PID" ]  && kill -TERM "$FM_PID"  2>/dev/null
  # 给 node 几秒优雅退出；超时强杀，确保端口一定释放
  for _ in 1 2 3 4 5; do
    kill -0 "$SRV_PID" 2>/dev/null || kill -0 "$FM_PID" 2>/dev/null || return 0
    sleep 1
  done
  kill -KILL "$SRV_PID" "$FM_PID" 2>/dev/null
  return 0
}
trap shutdown_children TERM INT EXIT

"$NODE_BIN" server.js &        SRV_PID=$!
"$NODE_BIN" file-manager.js &  FM_PID=$!

# wait -n：任一子进程退出即返回。runit 语义下 run 脚本退出＝服务退出，由 runsv 重启。
# 旧的裸 wait 会在其中一个挂掉后继续等另一个，服务处于"半死"而 runsv 毫无察觉。
wait -n
