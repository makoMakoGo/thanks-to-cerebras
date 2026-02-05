# VPS 部署指南

> 📖 相关文档：[README](../README.md) | [Docker 部署](DEPLOYMENT_DOCKER.md) | [Deno Deploy 部署](GUIDE.md)

## 安装 Deno

```bash
curl -fsSL https://deno.land/install.sh | sh

# 添加到 PATH
echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# 验证
deno --version
```

## 部署

```bash
git clone https://github.com/your-username/thanks-to-cerebras.git
cd thanks-to-cerebras
deno task start
```

## KV 数据存储

默认存储在项目目录下：

```
./src/.deno-kv-local/kv.sqlite3
```

可通过 `KV_PATH` 环境变量自定义：

```bash
KV_PATH=/var/lib/cerebras-proxy deno task start
```

## systemd 服务

创建 `/etc/systemd/system/cerebras-proxy.service`：

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

```bash
# 部署
sudo mkdir -p /opt/cerebras-proxy/data
sudo cp -r . /opt/cerebras-proxy/
sudo chown -R www-data:www-data /opt/cerebras-proxy

# 启动
sudo systemctl daemon-reload
sudo systemctl enable --now cerebras-proxy

# 查看日志
sudo journalctl -u cerebras-proxy -f
```

## 更新

```bash
cd /opt/cerebras-proxy
sudo -u www-data git pull
sudo systemctl restart cerebras-proxy
```
