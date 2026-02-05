# 部署指南（仅支持 Git 部署）

> 📖 相关文档：[README](../README.md) | [API 文档](API.md) | [技术细节](TECH_DETAILS.md)

## 部署方式选择

| 方式 | 适用场景 | 文档 |
|------|----------|------|
| Deno Deploy | 推荐，零运维 | 本文档 |
| VPS + systemd | 自有服务器 | [VPS 部署](DEPLOYMENT_VPS.md) |
| Docker | 容器化环境 | [Docker 部署](DEPLOYMENT_DOCKER.md) |

## 核心要点（先看这个）

- 唯一支持的部署方式：**从 Git 仓库部署到新 Deno Deploy**（`https://console.deno.com/`）
- 服务入口：`main.ts`
- 配置持久化：Deno KV（**需要在控制台手动创建并关联数据库**）
- 管理面板：首次访问必须设置管理密码
- 代理鉴权：通过管理面板创建代理密钥动态控制

## 不支持的部署方式（别再踩坑）

本项目**不再支持**以下部署方式，也不会为其维护文档/兼容性：

- Playgrounds 复制粘贴（单文件 bundle）
- Deploy Classic（`https://dash.deno.com/`）

原因很简单：新 Deploy 是多 Isolate 场景，复制粘贴方式很难保证运行配置与 KV
能力一致，问题只会越积越多。

## 部署流程

### 1. Fork 并部署到 Deno Deploy

```
GitHub Fork  ->  Deno Deploy（console）  ->  https://<project>.deno.dev/
   (main.ts + deno.json)         (entry: main.ts)            (admin UI)
```

1. 在 GitHub 上 **Fork** 本仓库到你的账号
2. 打开 [Deno Deploy 控制台](https://console.deno.com/)，创建新项目
3. 选择你 fork 的仓库，入口文件选 `main.ts`
4. 点击 Deploy

> 💡 同步上游更新：在你的 Fork 仓库页面点击 **Sync fork** 按钮

### 2. 创建并关联 KV 数据库（必须）

> **⚠️ 重要：新版 Deno Deploy 不会自动创建 KV 数据库，必须手动配置！**
>
> 如果跳过这一步，所有数据（管理密码、API 密钥等）都会在刷新后丢失。

1. 在 Deno Deploy 控制台左侧导航栏点击 **Databases**
2. 点击 **Provision Database** → 选择 **Deno KV** → 输入名称（如 `cerebras-kv`）→ 创建
3. 在数据库列表找到刚创建的数据库，点击 **Assign** → 选择你的应用
4. 等待状态变为 **Connected**

### 3. 验证部署

访问 `https://<project>.deno.dev/`，应看到管理面板登录页面。

查看日志应显示：

```
Cerebras Proxy 启动
- 管理面板: /
- API 代理: /v1/chat/completions
- 模型接口: /v1/models
- 存储: Deno KV
```

### 4. 首次配置

1. 浏览器打开 `https://<project>.deno.dev/`
2. 设置管理密码（至少 4 位）
3. 登录后添加 Cerebras API 密钥
4. （可选）创建代理访问密钥

### 5. （可选）调整 KV 刷盘间隔

默认每 15 秒刷盘一次（最小 1000ms）。部署后登录管理面板，在「访问控制」→「高级设置」里调整。

## 运维说明

### 管理面板

- 首次访问必须设置密码
- 登录会话有效期 7 天（过期后需重新输入密码，管理密码本身永久有效）
- 三个标签页：访问控制、API 密钥、模型配置

### 访问控制

- 无代理密钥时：公开访问
- 有代理密钥时：需 Bearer token 鉴权
- 最多 5 个代理密钥

### 模型下架处理（model_not_found）

当模型在上游被下架/不可用时，上游可能返回 `404 model_not_found`，导致请求失败。

本服务会在代理热路径做清理与重试：

- 发现 `model_not_found` 会把该模型从模型池中移除（持久化到 KV），并立刻切换到下一个模型继续重试（最多 3 次）
- 你可以在管理面板「模型配置」里重新勾选/保存模型池；也可以点击“刷新”更新模型目录

### 统计刷盘

默认每 15 秒将统计数据异步写回 KV，最终一致。

- 推荐在管理面板「访问控制」→「高级设置」里调整刷盘间隔
- 刷盘间隔会被钳制到 **最小 1000ms**（例如设置成 `0` 或 `500` 最终都会按 `1000ms` 执行）

## 客户端配置

```
API Base: https://<project>.deno.dev/v1
API Key: <代理密钥> 或任意（未启用鉴权时）
Model: 任意
```

## 常见问题

**刷新后数据全丢了（管理密码、API 密钥等）**

新版 Deno Deploy 需要手动创建并关联 KV 数据库。如果没有关联，`Deno.openKv()` 返回的是临时内存 KV，请求结束数据就丢失了。

解决方案：按照上面「创建并关联 KV 数据库」步骤操作。

**"没有可用的 API 密钥"** 至少保留一个状态为 active 的 Cerebras API 密钥。

**`TypeError: Deno.openKv is not a function`**

- 本项目依赖 Deno KV；请确认你是通过 Git 部署（仓库内含 `deno.json`）且入口文件为 `main.ts`
- 如果你硬要用 Playgrounds 复制粘贴，那就别来提 issue（本项目不支持）

**401 Unauthorized** 检查是否创建了代理密钥，客户端是否携带正确的 Bearer token。

**统计数据跳变** 多实例部署时各实例不共享内存缓存，统计受刷盘间隔影响。
