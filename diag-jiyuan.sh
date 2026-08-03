#!/usr/bin/env bash
# diag-jiyuan.sh — 在 DMgeo 设备本机(termux)运行，诊断"济源建点不显示"
# 只读脚本：只做 SELECT 与本地 HTTP 查询，不写库、不删数据。
# 用法:  bash diag-jiyuan.sh [db名，默认 trip]
set -u
DB="${1:-trip}"
PGPASSWORD=dmpageo123
PSQL="psql -U dmuser -h 127.0.0.1 -d"
echo "=================================================================="
echo "诊断库: $DB   时间: $(date '+%F %T')"
echo "=================================================================="

echo
echo "===== [1] features 里有没有济源相关点(plain map 应能看到) ====="
curl -s "http://127.0.0.1:8084/api/geo?db=$DB" \
  | grep -o '"name":"[^"]*济源[^"]*"' | sort -u
echo "--- (若上面有输出=点已存库；空=点根本没存进去，问题在录入不在底层数据)"

echo
echo "===== [2] 点亮/regional-stats 视图里济源点出现了吗 ====="
curl -s "http://127.0.0.1:8084/api/geo/regional-stats?db=$DB" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
except Exception as e:
    print('  [!] regional-stats 解析失败:',e); sys.exit(0)
print('  summary:', d.get('summary'))
for p in d.get('provinces',[]):
    if p['name']=='河南省':
        print('  河南省 下的市:', [c['name'] for c in p.get('cities',[])])
        for c in p.get('cities',[]):
            print('     ', c['name'], ' total=', c.get('total'))
"
echo "--- (若[1]有、[2]里济源/其点不在 → 坐实 ST_Contains 落不到市，被当海外/未知隐藏)"

echo
echo "===== [3] 边界表里济源在不在(cities / districts) ====="
PGPASSWORD=$PGPASSWORD $PSQL Basemap -c "SELECT 'cities' AS src,name,code FROM cities WHERE name LIKE '%济源%' UNION ALL SELECT 'districts',name,code FROM districts WHERE name LIKE '%济源%';"
echo "--- (空结果 = 济源根本不在边界表 → 根因确认: 底层边界数据优化时丢了济源)"

echo
echo "===== [4] 河南省下全部 city(看济源是否被并入焦作等) ====="
PGPASSWORD=$PGPASSWORD $PSQL Basemap -c "SELECT name,code FROM cities WHERE province_code='410000' ORDER BY name;"

echo
echo "=================================================================="
echo "判读:"
echo "  - [3] 空 且 [2] 找不到济源点  => 边界优化把济源丢了，需重拉 DataV 边界重导入"
echo "  - [3] 有济源 但 [2] 仍找不到  => 济源多边形与点的质心对不上(简化/空隙)，需查具体点"
echo "  - [1] 也空                  => 点没存进库，问题在录入端，非底层数据"
echo "=================================================================="
