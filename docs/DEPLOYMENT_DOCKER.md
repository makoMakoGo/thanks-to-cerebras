# Docker 部署指南

> 📖 相关文档：[README](../README.md) | [VPS 部署](DEPLOYMENT_VPS.md) | [Deno Deploy 部署](GUIDE.md)

## 快速开始

```bash
git clone https://github.com/zhu-jl18/thanks-to-cerebras.git
# 或 clone 你的 fork：https://github.com/<your-username>/thanks-to-cerebras.git
cd thanks-to-cerebras
docker compose up -d
```

访问 `http://localhost:8000` 进入管理面板。

## 数据持久化

KV 数据通过 Docker Volume 持久化在 `cerebras-kv` 卷中，容器内路径 `/app/data`。

### 备份与恢复

```bash
# 备份
docker run --rm -v cerebras-kv:/data -v $(pwd):/backup alpine \
  tar czf /backup/cerebras-kv-backup.tar.gz -C /data .

# 恢复
docker run --rm -v cerebras-kv:/data -v $(pwd):/backup alpine \
  sh -c "cd /data && tar xzf /backup/cerebras-kv-backup.tar.gz"
```

## 更新

```bash
git pull
docker compose up -d --build
```
