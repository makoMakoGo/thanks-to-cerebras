# 本地开发指南

> 📖 相关文档：[README](../README.md) | [部署指南](GUIDE.md) | [API 文档](API.md)

## 环境要求

- **Deno 2.x** 或更高版本
- 操作系统：Windows / macOS / Linux

## 安装 Deno

### Windows

```powershell
# PowerShell
irm https://deno.land/install.ps1 | iex
```

### macOS / Linux

```bash
curl -fsSL https://deno.land/install.sh | sh
```

### 验证安装

```bash
deno --version
# 输出示例：deno 2.x.x
```

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/your-username/thanks-to-cerebras.git
cd thanks-to-cerebras

# 启动开发服务器
deno task dev
```

访问 `http://localhost:8000` 进入管理面板。

## deno task 命令

| 命令 | 说明 |
|------|------|
| `deno task dev` | 启动开发服务器 |
| `deno task start` | 启动生产服务器 |
| `deno task test` | 运行集成测试 |
| `deno task test:unit` | 运行单元测试 |
| `deno task test:coverage` | 运行测试并生成覆盖率报告 |
| `deno task check` | 类型检查 |
| `deno task lint` | 代码风格检查 |
| `deno task fmt:check` | 格式检查 |

## 本地 KV 存储

本地运行时，KV 数据存储在：

```
src/.deno-kv-local/kv.sqlite3
```

可通过环境变量 `KV_PATH` 自定义存储路径：

```bash
KV_PATH=/custom/path deno task dev
```

## 代码结构

```
.
├── main.ts              # 入口文件
├── deno.json            # Deno 配置
├── src/
│   ├── state.ts         # 全局状态与 KV 初始化
│   ├── kv.ts            # KV 操作封装
│   ├── auth.ts          # 鉴权逻辑
│   ├── api-keys.ts      # API 密钥管理
│   ├── models.ts        # 模型池管理
│   ├── http.ts          # HTTP 请求工具
│   ├── crypto.ts        # 加密工具
│   ├── keys.ts          # 密钥生成
│   ├── utils.ts         # 通用工具函数
│   ├── constants.ts     # 常量定义
│   ├── types.ts         # TypeScript 类型
│   ├── handlers/        # HTTP 请求处理器
│   │   ├── proxy.ts     # 代理请求
│   │   ├── auth.ts      # 鉴权接口
│   │   ├── config.ts    # 配置接口
│   │   ├── api-keys.ts  # API 密钥接口
│   │   ├── proxy-keys.ts# 代理密钥接口
│   │   └── models.ts    # 模型接口
│   ├── ui/              # 管理面板
│   │   ├── admin.ts     # 面板路由
│   │   └── admin_page.ts# 面板 HTML
│   └── __tests__/       # 单元测试
└── docs/                # 文档
```

## VS Code 调试配置

创建 `.vscode/launch.json`：

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Deno: Run",
      "type": "node",
      "request": "launch",
      "runtimeExecutable": "deno",
      "runtimeArgs": [
        "run",
        "--allow-net",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--inspect-brk"
      ],
      "program": "${workspaceFolder}/main.ts",
      "attachSimplePort": 9229
    }
  ]
}
```

## 推荐 VS Code 扩展

- [Deno](https://marketplace.visualstudio.com/items?itemName=denoland.vscode-deno) - Deno 语言支持

在项目根目录创建 `.vscode/settings.json`：

```json
{
  "deno.enable": true,
  "deno.lint": true,
  "deno.unstable": ["kv"]
}
```

## 常见问题

**`TypeError: Deno.openKv is not a function`**

确保 `deno.json` 中包含：

```json
{
  "unstable": ["kv"]
}
```

**端口被占用**

默认监听 8000 端口，如需更改可修改 `main.ts` 中的端口配置。

**KV 数据想重置**

删除 `src/.deno-kv-local/` 目录即可：

```bash
rm -rf src/.deno-kv-local
```
