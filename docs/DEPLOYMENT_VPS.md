# VPS 部署指南

> 📖 相关文档：[README](../README.md) | [Docker 部署](DEPLOYMENT_DOCKER.md) | [Deno Deploy 部署](GUIDE.md)

## 环境要求

- Linux 服务器（Ubuntu/Debian/CentOS）
- Deno 2.x
- （可选）Nginx / Caddy 反向代理
- （可选）域名 + SSL 证书

## 安装 Deno

```bash
curl -fsSL https://deno.land/install.sh | sh

# 添加到 PATH（根据 shell 类型选择）
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# 验证安装
deno --version
```

## 部署应用

```bash
# 克隆仓库
git clone https://github.com/your-username/thanks-to-cerebras.git
cd thanks-to-cerebras

# 测试运行
deno task start
```

## systemd 服务配置

创建服务文件 `/etc/systemd/system/cerebras-proxy.service`：

```ini
[Unit]
Description=Cerebras Proxy Service
After=network.target

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/opt/cerebras-proxy
Environment=KV_PATH=/opt/cerebras-proxy/data
ExecStart=/home/your-user/.deno/bin/deno run --allow-net --allow-env --allow-read --allow-write main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

部署步骤：

```bash
# 复制代码到部署目录
sudo mkdir -p /opt/cerebras-proxy
sudo cp -r . /opt/cerebras-proxy/
sudo chown -R www-data:www-data /opt/cerebras-proxy

# 创建数据目录
sudo mkdir -p /opt/cerebras-proxy/data
sudo chown www-data:www-data /opt/cerebras-proxy/data

# 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable cerebras-proxy
sudo systemctl start cerebras-proxy

# 查看状态
sudo systemctl status cerebras-proxy

# 查看日志
sudo journalctl -u cerebras-proxy -f
```

## Nginx 反向代理

### 安装 Nginx

```bash
# Ubuntu/Debian
sudo apt update && sudo apt install nginx -y

# CentOS
sudo yum install nginx -y
```

### 配置文件

创建 `/etc/nginx/sites-available/cerebras-proxy`：

```nginx
server {
    listen 80;
    server_name cerebras.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 86400;
    }
}
```

启用配置：

```bash
sudo ln -s /etc/nginx/sites-available/cerebras-proxy /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 启用 HTTPS（Certbot）

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx -y

# 获取证书
sudo certbot --nginx -d cerebras.example.com

# 自动续期（通常已自动配置）
sudo certbot renew --dry-run
```

## Caddy 反向代理

### 安装 Caddy

```bash
# Ubuntu/Debian
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy -y
```

### 配置文件

编辑 `/etc/caddy/Caddyfile`：

```
cerebras.example.com {
    reverse_proxy localhost:8000
}
```

重载配置：

```bash
sudo systemctl reload caddy
```

Caddy 会自动获取和续期 SSL 证书。

## 防火墙配置

### UFW（Ubuntu）

```bash
# 允许 SSH
sudo ufw allow ssh

# 允许 HTTP/HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# 启用防火墙
sudo ufw enable

# 查看状态
sudo ufw status
```

### firewalld（CentOS）

```bash
# 允许 HTTP/HTTPS
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload

# 查看状态
sudo firewall-cmd --list-all
```

## 更新部署

```bash
cd /opt/cerebras-proxy
sudo -u www-data git pull
sudo systemctl restart cerebras-proxy
```

## 常用命令

```bash
# 查看服务状态
sudo systemctl status cerebras-proxy

# 启动/停止/重启
sudo systemctl start cerebras-proxy
sudo systemctl stop cerebras-proxy
sudo systemctl restart cerebras-proxy

# 查看日志
sudo journalctl -u cerebras-proxy -f
sudo journalctl -u cerebras-proxy --since "1 hour ago"

# 查看 Nginx 日志
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

## 故障排查

**服务无法启动**

```bash
# 检查 Deno 路径
which deno

# 手动测试运行
cd /opt/cerebras-proxy
sudo -u www-data /home/your-user/.deno/bin/deno run --allow-net --allow-env --allow-read --allow-write main.ts
```

**端口被占用**

```bash
# 检查端口占用
sudo lsof -i :8000
sudo netstat -tlnp | grep 8000
```

**权限问题**

```bash
# 检查目录权限
ls -la /opt/cerebras-proxy/
ls -la /opt/cerebras-proxy/data/

# 修复权限
sudo chown -R www-data:www-data /opt/cerebras-proxy
```

**Nginx 502 Bad Gateway**

```bash
# 检查后端服务是否运行
curl http://127.0.0.1:8000/v1/models

# 检查 Nginx 配置
sudo nginx -t
```
