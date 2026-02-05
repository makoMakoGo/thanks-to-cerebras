# VPS 部署指南

> 📖 相关文档：[README](../README.md) | [Docker 部署](DEPLOYMENT_DOCKER.md) | [Deno Deploy 部署](GUIDE.md)

## 安装 Deno（推荐：系统级）

```bash
curl -fsSL https://deno.land/install.sh | sudo DENO_INSTALL=/usr/local sh
deno --version
```

> 只装到当前用户也可以（但不推荐用于 systemd），参考：
>
> ```bash
> curl -fsSL https://deno.land/install.sh | sh
> echo 'export DENO_INSTALL="$HOME/.deno"' >> ~/.bashrc
> echo 'export PATH="$DENO_INSTALL/bin:$PATH"' >> ~/.bashrc
> source ~/.bashrc
> deno --version
> ```

## 部署（前台运行用于验证）

```bash
git clone https://github.com/zhu-jl18/thanks-to-cerebras.git
# 或 clone 你的 fork：https://github.com/<your-username>/thanks-to-cerebras.git
cd thanks-to-cerebras
deno task start
```

## KV 数据存储

默认存储在项目目录下：

```
./src/.deno-kv-local/kv.sqlite3
```

可通过 `KV_PATH` 环境变量自定义（`KV_PATH` 为目录，实际文件为
`<KV_PATH>/kv.sqlite3`）：

```bash
KV_PATH=/var/lib/cerebras-proxy deno task start
```

## systemd 服务

推荐创建独立用户与数据目录：

```bash
sudo useradd -r -m -d /opt/cerebras-proxy -s /usr/sbin/nologin cerebras-proxy
sudo mkdir -p /opt/cerebras-proxy/app /var/lib/cerebras-proxy
sudo chown -R cerebras-proxy:cerebras-proxy /opt/cerebras-proxy /var/lib/cerebras-proxy

sudo -u cerebras-proxy git clone https://github.com/zhu-jl18/thanks-to-cerebras.git /opt/cerebras-proxy/app
# 或 clone 你的 fork：https://github.com/<your-username>/thanks-to-cerebras.git
```

创建 `/etc/systemd/system/cerebras-proxy.service`：

```ini
[Unit]
Description=Cerebras Proxy Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=cerebras-proxy
Group=cerebras-proxy
WorkingDirectory=/opt/cerebras-proxy/app
Environment=KV_PATH=/var/lib/cerebras-proxy
ExecStart=/usr/local/bin/deno task start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
# 启动
sudo systemctl daemon-reload
sudo systemctl enable --now cerebras-proxy

# 查看日志
sudo journalctl -u cerebras-proxy -f
```

## 更新

```bash
sudo -u cerebras-proxy git -C /opt/cerebras-proxy/app pull
sudo systemctl restart cerebras-proxy
```
