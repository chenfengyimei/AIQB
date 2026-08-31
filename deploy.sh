#!/usr/bin/env bash
#
# deploy.sh — AIQB 一键安装 / 升级脚本
# 支持: Ubuntu 22.04/24.04 · Debian 12 · OpenCloudOS 9 · CentOS/Rocky 9 （自动识别 apt/dnf）
# 用法:  sudo bash deploy.sh your-domain.com [email]
# 前提:  域名已解析到本服务器公网 IP；80/443 端口已放行。
# 效果:  安装 Node 20 + PM2 + Nginx + certbot；PM2 启动 2 个 Web 实例和独立采集器；
#         Nginx 反代 80/443 → Web 端口；自动签发 Let's Encrypt 证书并配置自动续期。
#
set -euo pipefail
umask 027

# ---------- 参数 ----------
DOMAIN="${1:-}"
APP_DIR="${APP_DIR:-/opt/ai-dashboard}"
PORT="${PORT:-3000}"
LETSENCRYPT_EMAIL="${2:-${EMAIL:-}}"   # 可选，用于证书到期提醒
SITE_NAME="${SITE_NAME:-AI圈报}"
ENDPOINT_PRESET="${AIQB_ENDPOINT_PRESET:-community}"
SERVICE_USER="${AIQB_SERVICE_USER:-aiqb}"
ALLOW_HTTP_ORIGIN="${AIQB_ALLOW_HTTP_ORIGIN:-0}"
BACKUP_DIR=""

if [[ -z "$DOMAIN" ]]; then
  echo "用法: sudo bash deploy.sh your-domain.com [email]"
  echo "示例: sudo bash deploy.sh ai.example.com admin@example.com"
  exit 1
fi

if [[ ! "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "域名格式无效: $DOMAIN（只填写域名，不要带 http://、路径或端口）"
  exit 1
fi
if [[ ! "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1024 || PORT > 65534 )); then
  echo "PORT 必须是 1024–65534 之间的端口"
  exit 1
fi
if [[ ! "$ENDPOINT_PRESET" =~ ^(community|empty|full)$ ]]; then
  echo "AIQB_ENDPOINT_PRESET 仅支持 community、empty 或 full"
  exit 1
fi
if [[ "$APP_DIR" == "/" || -z "$APP_DIR" ]]; then
  echo "APP_DIR 不能是根目录"
  exit 1
fi
if [[ ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]{0,30}$ ]]; then
  echo "AIQB_SERVICE_USER 格式无效"
  exit 1
fi

# 非 root 提示
if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行: sudo bash deploy.sh $DOMAIN"
  exit 1
fi

echo "==> 目标域名: $DOMAIN"
echo "==> 部署目录: $APP_DIR"
echo "==> 后端端口: $PORT"
echo "==> 接口预设: $ENDPOINT_PRESET"
echo "==> 服务账户: $SERVICE_USER"

# ---------- 识别包管理器 ----------
if command -v apt-get >/dev/null 2>&1; then
  PKG_MGR="apt"
elif command -v dnf >/dev/null 2>&1; then
  PKG_MGR="dnf"
else
  echo "!! 未识别的系统（需要 apt-get 或 dnf），请手动安装 Node 20+ 后重试"
  exit 1
fi
echo "==> 包管理器: $PKG_MGR"

# ---------- 1. 系统依赖 ----------
echo "==> [1/6] 更新系统并安装基础依赖..."
if [[ "$PKG_MGR" == "apt" ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg nginx openssl >/dev/null
else
  dnf install -y -q curl ca-certificates gnupg2 nginx openssl policycoreutils-python-utils >/dev/null 2>&1 || \
    dnf install -y -q curl ca-certificates gnupg2 nginx openssl >/dev/null
  # RHEL 系 SELinux：允许 Nginx 反代到本机端口（OpenCloudOS 9 默认 enforcing）
  if command -v setsebool >/dev/null 2>&1; then
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
  fi
fi

# ---------- 2. Node.js 20 ----------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null | sed 's/v//;s/\..*//')" -lt 18 ]]; then
  echo "==> [2/6] 安装 Node.js 20（NodeSource）..."
  if [[ "$PKG_MGR" == "apt" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    # RHEL 系（含 OpenCloudOS 9）：优先 dnf module，失败再走 NodeSource
    dnf module enable -y nodejs:20 >/dev/null 2>&1 && \
      dnf install -y -q nodejs >/dev/null 2>&1 || {
        curl -fsSL https://rpm.nodesource.com/setup_20.x | bash - >/dev/null
        dnf install -y -q nodejs >/dev/null
      }
  fi
fi
echo "Node 版本: $(node -v)"

# ---------- 3. 部署代码 + PM2 常驻 ----------
echo "==> [3/6] 备份、拷贝代码并安装 PM2..."
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${SERVICE_USER}" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[[ -n "$SERVICE_HOME" ]] || SERVICE_HOME="/home/${SERVICE_USER}"
mkdir -p "$APP_DIR" "${APP_DIR}-backups" "$SERVICE_HOME"
chmod 750 "$APP_DIR" "${APP_DIR}-backups"
# 本脚本所在目录的 server/ frontend/ 拷贝过去（支持从部署包目录运行）
# 说明：server/data/ 运行数据目录由后端自动创建；若 $APP_DIR/server/ 下存在旧版
#       data.json（单文件缓存），后端首次启动会自动迁移为历史快照，无需人工处理。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/server" && -d "$SCRIPT_DIR/frontend" ]]; then
  if [[ -d "$APP_DIR/server" || -d "$APP_DIR/frontend" ]]; then
    BACKUP_DIR="${APP_DIR}-backups/$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    if [[ -d "$APP_DIR/server" ]]; then
      mkdir -p "$BACKUP_DIR/server"
      [[ -f "$APP_DIR/server/server.js" ]] && cp -a "$APP_DIR/server/server.js" "$BACKUP_DIR/server/"
      [[ -d "$APP_DIR/server/lib" ]] && cp -a "$APP_DIR/server/lib" "$BACKUP_DIR/server/"
      [[ -f "$APP_DIR/server/data.json" ]] && cp -a "$APP_DIR/server/data.json" "$BACKUP_DIR/server/"
      if [[ -d "$APP_DIR/server/data" ]]; then
        echo "==> 正在创建完整运行数据备份（账号、情报、统计、配置与历史）..."
        tar -C "$APP_DIR/server" --exclude='data/auth/initial-password.txt' -czf "$BACKUP_DIR/server-data.tar.gz" data
        sha256sum "$BACKUP_DIR/server-data.tar.gz" > "$BACKUP_DIR/server-data.tar.gz.sha256"
      fi
    fi
    [[ -d "$APP_DIR/frontend" ]] && cp -a "$APP_DIR/frontend" "$BACKUP_DIR/"
    [[ -f "$APP_DIR/package.json" ]] && cp -a "$APP_DIR/package.json" "$BACKUP_DIR/"
    echo "==> 已创建升级备份: $BACKUP_DIR"
  fi
  mkdir -p "$APP_DIR/server"
  cp "$SCRIPT_DIR/server/server.js" "$APP_DIR/server/server.js"
  cp -r "$SCRIPT_DIR/server/lib" "$APP_DIR/server/"
  [[ -f "$SCRIPT_DIR/server/data.json" && ! -f "$APP_DIR/server/data.json" ]] && cp "$SCRIPT_DIR/server/data.json" "$APP_DIR/server/data.json"
  cp -r "$SCRIPT_DIR/frontend/." "$APP_DIR/frontend/"
  cp "$SCRIPT_DIR/package.json" "$SCRIPT_DIR/package-lock.json" "$SCRIPT_DIR/ecosystem.config.js" "$APP_DIR/"
  mkdir -p "$APP_DIR/scripts"
  cp "$SCRIPT_DIR/scripts/setup.js" "$APP_DIR/scripts/setup.js"
  cp "$SCRIPT_DIR/scripts/bootstrap_admin.js" "$APP_DIR/scripts/bootstrap_admin.js"
  cp "$SCRIPT_DIR/scripts/backup_data.js" "$APP_DIR/scripts/backup_data.js"
  cp "$SCRIPT_DIR/scripts/online_update.js" "$APP_DIR/scripts/online_update.js"
else
  echo "!! 未找到 server/ 与 frontend/ 目录，请确保在解压后的部署包目录内执行本脚本"
  exit 1
fi

# 安装 PM2（全局）
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 >/dev/null 2>&1
fi
export PATH="$PATH:$(npm prefix -g)/bin"

cd "$APP_DIR"
# 宝塔等面板可能给 frontend/.user.ini 加 immutable 属性；它不属于 AIQB 代码，
# 升级时保留并跳过，避免一次无关的 chown 失败中断安全迁移。
find "$APP_DIR" -path "$APP_DIR/frontend/.user.ini" -prune -o -exec chown "$SERVICE_USER:$SERVICE_USER" {} +
chown -R "$SERVICE_USER:$SERVICE_USER" "${APP_DIR}-backups" "$SERVICE_HOME"
run_as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$PATH" "$@"
}
run_as_service npm ci --omit=dev

# tar 已保存全部文件；另外使用 SQLite 在线备份 API 生成事务一致的数据库副本，
# 即使升级时仍有前台访问写入 WAL，也能可靠恢复账号、配置、统计和情报状态。
if [[ -n "$BACKUP_DIR" && -f "$APP_DIR/server/data/db/aiqb.sqlite" ]]; then
  node scripts/backup_data.js --data-dir "$APP_DIR/server/data" --output-dir "$BACKUP_DIR"
  sha256sum "$BACKUP_DIR/aiqb.sqlite.consistent-backup" > "$BACKUP_DIR/aiqb.sqlite.consistent-backup.sha256"
fi

# 只在全新数据目录生成站点配置；升级时 setup 会明确保留账号、接口、统计与历史。
run_as_service node scripts/setup.js --non-interactive --data-dir "$APP_DIR/server/data" --site-url "https://${DOMAIN}" --site-name "$SITE_NAME" --preset "$ENDPOINT_PRESET"

# 新安装必须在启动 Web 服务前由本机一次性设置管理员密码。密码仅经管道传给
# 初始化进程，应用只保存 scrypt 哈希；不会写入文件、命令行参数或部署日志。
if [[ ! -s "$APP_DIR/server/data/auth/users.json" ]]; then
  ADMIN_PASSWORD="${AIQB_INITIAL_ADMIN_PASSWORD:-}"
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    if [[ ! -t 0 ]]; then
      echo "!! 非交互安装请临时设置 AIQB_INITIAL_ADMIN_PASSWORD（12–128 位）。"
      exit 1
    fi
    read -r -s -p "设置后台管理员密码（12–128 位，不回显）: " ADMIN_PASSWORD
    echo
    read -r -s -p "再次输入后台管理员密码: " ADMIN_PASSWORD_CONFIRM
    echo
    if [[ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]]; then
      unset ADMIN_PASSWORD ADMIN_PASSWORD_CONFIRM
      echo "!! 两次输入的管理员密码不一致"
      exit 1
    fi
    unset ADMIN_PASSWORD_CONFIRM
  fi
  if (( ${#ADMIN_PASSWORD} < 12 || ${#ADMIN_PASSWORD} > 128 )); then
    unset ADMIN_PASSWORD
    echo "!! 管理员密码必须为 12–128 位"
    exit 1
  fi
  printf '%s\n' "$ADMIN_PASSWORD" | run_as_service node scripts/bootstrap_admin.js --password-stdin --data-dir "$APP_DIR/server/data"
  unset ADMIN_PASSWORD AIQB_INITIAL_ADMIN_PASSWORD
fi

echo "==> 启动双 Web 实例与独立采集器 (PM2)..."
pm2 delete aiqb-backend aiqb-web aiqb-collector >/dev/null 2>&1 || true
run_as_service pm2 delete aiqb-backend aiqb-web aiqb-collector >/dev/null 2>&1 || true
runuser -u "$SERVICE_USER" -- env HOME="$SERVICE_HOME" PATH="$PATH" AIQB_HOST="127.0.0.1" AIQB_TRUSTED_PROXIES="127.0.0.1,::1" AIQB_PORT="$PORT" AIQB_COLLECTOR_PORT="$((PORT + 1))" AIQB_ENDPOINT_PRESET="$ENDPOINT_PRESET" pm2 start ecosystem.config.js --update-env
run_as_service pm2 save

# 开机自启
pm2 startup systemd -u "$SERVICE_USER" --hp "$SERVICE_HOME" >/dev/null 2>&1 || true
# PM2 7 在部分 OpenCloudOS/systemd 组合下不保留生成单元要求的 pm2.pid，
# Type=forking 会误判启动失败。改为 oneshot + RemainAfterExit，仍由 pm2 resurrect/kill 管理。
PM2_UNIT="/etc/systemd/system/pm2-${SERVICE_USER}.service"
if [[ -f "$PM2_UNIT" ]]; then
  sed -i 's/^Type=forking$/Type=oneshot/; /^PIDFile=/d; /^Restart=/d; /^WorkingDirectory=/d; /^RemainAfterExit=/d' "$PM2_UNIT"
  sed -i "/^User=${SERVICE_USER}$/a WorkingDirectory=${APP_DIR}" "$PM2_UNIT"
  sed -i '/^ExecStop=/a RemainAfterExit=yes' "$PM2_UNIT"
  systemctl daemon-reload
  systemctl enable "pm2-${SERVICE_USER}" >/dev/null 2>&1 || true
fi

# 首次采集可能需要几秒，轮询 /health
echo "==> 等待后端就绪..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    echo "后端已就绪: http://127.0.0.1:${PORT}/health"
    break
  fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/health" || echo "!! 后端未就绪，请查看: pm2 logs aiqb-web"

# ---------- 4. Nginx 配置 ----------
echo "==> [4/6] 写入 Nginx 站点配置..."
# Debian 系用 sites-available/sites-enabled；RHEL 系（OpenCloudOS 9 等）用 conf.d
if [[ -d /etc/nginx/sites-available ]]; then
  NGINX_CONF="/etc/nginx/sites-available/${DOMAIN}"
  NGINX_LINK="/etc/nginx/sites-enabled/${DOMAIN}"
else
  NGINX_CONF="/etc/nginx/conf.d/${DOMAIN}.conf"
  NGINX_LINK=""
fi
cat > "$NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        # 覆盖而不是追加客户端提供的转发头。CDN 真实 IP 应先通过 Nginx
        # real_ip 模块和官方 CIDR 白名单写入 \$remote_addr。
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header EO-Connecting-IP "";
        proxy_set_header EO-Client-IP "";
        proxy_set_header True-Client-IP "";
        proxy_read_timeout 60s;
    }
}
EOF
if [[ -n "$NGINX_LINK" ]]; then
  ln -sf "$NGINX_CONF" "$NGINX_LINK"
  # 移除默认站点避免冲突（Debian 系）
  rm -f /etc/nginx/sites-enabled/default
else
  # RHEL 系：移除自带默认配置避免端口冲突
  rm -f /etc/nginx/conf.d/default.conf
fi

nginx -t
systemctl reload nginx
echo "Nginx 已配置: http://${DOMAIN}/"

# ---------- 5. HTTPS (Let's Encrypt) ----------
echo "==> [5/6] 安装 certbot 并签发证书..."
if ! command -v certbot >/dev/null 2>&1; then
  if [[ "$PKG_MGR" == "apt" ]]; then
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  else
    dnf install -y -q certbot python3-certbot-nginx >/dev/null 2>&1 || \
      dnf install -y -q certbot >/dev/null
  fi
fi

CERTBOT_ARGS=(certbot --nginx -d "$DOMAIN" --redirect --agree-tos --non-interactive)
if [[ -n "$LETSENCRYPT_EMAIL" ]]; then
  CERTBOT_ARGS+=(--email "$LETSENCRYPT_EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi
if ! "${CERTBOT_ARGS[@]}"; then
  echo "!! 证书签发失败（常见原因：域名未解析到本机 / 防火墙未放行 80/443）。"
  echo "   修复后重跑: sudo certbot --nginx -d ${DOMAIN} --redirect"
  if [[ "$ALLOW_HTTP_ORIGIN" != "1" ]]; then
    echo "!! 安全策略已停止 AIQB 服务，不允许后台凭据通过明文 HTTP 传输。"
    run_as_service pm2 stop aiqb-web aiqb-collector >/dev/null 2>&1 || true
    exit 1
  fi
  echo "!! 已显式设置 AIQB_ALLOW_HTTP_ORIGIN=1；仅应在源站端口受防火墙/CDN 严格保护时临时使用。"
else
  echo "HTTPS 已启用: https://${DOMAIN}/"
fi

# ---------- 6. 验证 ----------
echo "==> [6/6] 验证..."
sleep 1
echo "--------------------------------------------"
echo "部署完成！"
echo "  看板地址:   https://${DOMAIN}/"
echo "  管理后台:   https://${DOMAIN}/chenfengadmin"
echo "  后台账号:   admin（密码为安装时一次性设置，系统不保存明文）"
echo "  后端健康:   curl http://127.0.0.1:${PORT}/health"
echo "  日志:       sudo -u $SERVICE_USER pm2 logs aiqb-web 及 aiqb-collector"
echo "  重启:       sudo -u $SERVICE_USER pm2 reload aiqb-web && sudo -u $SERVICE_USER pm2 restart aiqb-collector"
echo "  自动采集:   每 12 小时自动刷新，每次采集全量留档（后台可查历史/改间隔）"
echo "  默认接口:   $([[ "$ENDPOINT_PRESET" == "community" ]] && echo 'AI圈报 RSS（后台可停用、编辑或添加更多接口）' || echo "$ENDPOINT_PRESET")"
echo "  手动采集:   登录后台后使用「立即采集」（公开 /api/refresh 已关闭）"
echo "--------------------------------------------"
