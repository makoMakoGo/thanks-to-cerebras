# Docker 部署指南

> 📖 相关文档：[README](../README.md) | [VPS 部署](DEPLOYMENT_VPS.md) | [Deno Deploy 部署](GUIDE.md)

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/your-username/thanks-to-cerebras.git
cd thanks-to-cerebras

# 启动服务
docker compose up -d

# 查看日志
docker compose logs -f
```

访问 `http://localhost:8000` 进入管理面板。

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `KV_PATH` | KV 数据存储路径 | `/app/data` |

可在 `docker-compose.yml` 中配置：

```yaml
services:
  cerebras-proxy:
    build: .
    ports:
      - "8000:8000"
    environment:
      - KV_PATH=/app/data
    volumes:
      - cerebras-kv:/app/data
    restart: unless-stopped
```

## 数据持久化

KV 数据通过 Docker Volume 持久化：

```yaml
volumes:
  cerebras-kv:
```

### 备份数据

```bash
# 创建备份
docker run --rm -v cerebras-kv:/data -v $(pwd):/backup alpine \
  tar czf /backup/cerebras-kv-backup.tar.gz -C /data .

# 恢复备份
docker run --rm -v cerebras-kv:/data -v $(pwd):/backup alpine \
  sh -c "cd /data && tar xzf /backup/cerebras-kv-backup.tar.gz"
```

## 与反向代理配合

### Traefik

```yaml
services:
  cerebras-proxy:
    build: .
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.cerebras.rule=Host(`cerebras.example.com`)"
      - "traefik.http.routers.cerebras.entrypoints=websecure"
      - "traefik.http.routers.cerebras.tls.certresolver=letsencrypt"
      - "traefik.http.services.cerebras.loadbalancer.server.port=8000"
    volumes:
      - cerebras-kv:/app/data
    restart: unless-stopped
    networks:
      - traefik

networks:
  traefik:
    external: true

volumes:
  cerebras-kv:
```

### Nginx Proxy Manager

1. 在 NPM 中添加 Proxy Host
2. Domain: `cerebras.example.com`
3. Forward Hostname: `cerebras-proxy`
4. Forward Port: `8000`
5. 启用 SSL（Let's Encrypt）

确保容器在同一网络：

```yaml
services:
  cerebras-proxy:
    build: .
    volumes:
      - cerebras-kv:/app/data
    restart: unless-stopped
    networks:
      - npm_default

networks:
  npm_default:
    external: true

volumes:
  cerebras-kv:
```

### Caddy

如果使用 Caddy 作为反向代理：

```
cerebras.example.com {
    reverse_proxy cerebras-proxy:8000
}
```

## 常用命令

```bash
# 启动服务
docker compose up -d

# 停止服务
docker compose down

# 查看日志
docker compose logs -f

# 重新构建镜像
docker compose build --no-cache

# 重启服务
docker compose restart

# 查看容器状态
docker compose ps
```

## 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker compose up -d --build
```

## 自定义端口

修改 `docker-compose.yml` 中的端口映射：

```yaml
ports:
  - "3000:8000"  # 将宿主机 3000 端口映射到容器 8000 端口
```

## 健康检查

可添加健康检查配置：

```yaml
services:
  cerebras-proxy:
    build: .
    ports:
      - "8000:8000"
    volumes:
      - cerebras-kv:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/v1/models"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 10s
```

## 故障排查

**容器无法启动**

```bash
# 查看详细日志
docker compose logs cerebras-proxy

# 检查容器状态
docker compose ps -a
```

**数据丢失**

确保正确配置了 Volume：

```bash
# 检查 Volume 是否存在
docker volume ls | grep cerebras

# 检查 Volume 内容
docker run --rm -v cerebras-kv:/data alpine ls -la /data
```

**端口冲突**

检查端口占用：

```bash
# Linux/macOS
lsof -i :8000

# Windows
netstat -ano | findstr :8000
```
