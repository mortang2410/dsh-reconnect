# dsh-reconnect

> 为 DeepSeek Harness 提供模型请求安全自动重试、指数退避、不稳定中转站/代理恢复能力,以及可视化配置面板。

**版本:** `2.0.0`

- [English README](./README.md)

## 项目简介

`dsh-reconnect` 是一个 DeepSeek Harness (DSH) Host 端插件。模型请求失败时,插件会自动重新发送请求,避免临时网络故障、中转站不稳定或服务端波动导致 Agent 回合中断。

插件监听 DSH 的 `agent/request-error` 瀑布事件。Provider 的 `normal` 重试策略耗尽后,或 Provider 的 `always` 策略把恢复决定交给下游后,Agent 循环会按照本插件策略重新发送同一个请求。

## 适用场景

- 不稳定的中转站、反向代理、API 网关或转发服务
- 中转节点偶发断开、重置连接或返回不完整响应
- 网络抖动、传输错误和连接超时
- 模型服务临时不可用、5xx 错误、限流或过载
- 需要长时间运行且不能被短暂故障打断的任务

## 重试策略

| 情况 | 处理 |
| --- | --- |
| `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `STREAM_CLOSED` / `TIMEOUT` / `TRANSPORT` | 无限重试(连接/服务临时故障) |
| 模型不存在/未配置(`MODEL_NOT_FOUND`、`MODEL_NOT_CONFIGURED`或对应 Provider 文本) | 无限重试,等待模型或账号配置恢复 |
| `QUOTA`(余额不足或额度耗尽) | 默认不重试;设置 `retryQuota: true` 后进入重试流程 |
| `PI_AI_ERROR` 等未知错误 | 默认无限重试;关闭 `retryUnknown` 后才使用可配置的连续失败上限 |
| 工具/参数/未知工具/认证/凭据/上下文超限/中止 | 一律不重试,直接结束本步 |

关键设计:

- 只重试能靠「重发同一个请求」解决的问题——连接断、限流、超时、5xx。
- 工具执行错误(`tool/result`)不在本插件重试边界内。错误路由优先使用 `agent/request-error` 的机器码,不再根据 message 文本猜测;未知机器码按配置的未知错误策略处理,只有关闭 `retryUnknown` 时才限次。
- 永久性错误(凭据、请求内容、上下文超限)直接停止;模型不存在/未配置是例外,会持续重试等待配置恢复。
- `retryQuota` 和 `retryUnknown` 只控制本插件的兜底链。Host 的 `always` 策略会把恢复决定交给下游瀑布,因此本插件负责一次性处理可恢复错误,不会创建并行的第二条重试循环。

## 退避与停止

- 指数退避: `1s -> 2s -> 4s -> ...`,默认最长等待 `60s`(设置面板可选 1/2/5/10/30/60/120 秒或自定义,毫秒值另可写 `maxDelayMs`)
- 如果服务端提供正的 `providerRetryAfterMs`,直接尊重它。它是 Provider 要求的最短等待,不受本地指数退避上限约束;只受 Node 定时器物理上限限制
- 记录 Provider、错误码、回合、步骤、重试次数和等待时间
- 写入标准 `llm/retry` 事件,Harness 会话界面显示连续重试次数和倒计时
- 用户停止回合、插件停止或热重载后立即取消等待,清理时会等待活动重试 Promise 结束

## 可视化配置

打开“设置 → 插件配置”,ReConnect 会作为插件卡片显示在该页面:

- **单次最大等待**:下拉预设(1/2/5/10/30/60/120 秒)或自定义秒数
- **欠费也重试**:开关,默认关闭
- **未知错误也无限重试**:开关,默认开启
- **未知错误最大重试次数**:默认 3。模型不存在/未配置错误不受此上限影响,始终无限重试。

保存后立即生效,无需重启 DSH。

## 配置文件(yaml)配置

插件接受 Cordis 行配置中的可选值:

- `maxDelayMs`(整数毫秒,默认 `60000`):封顶本地指数退避等待,例如 `15000` 时退避为 `1s -> 2s -> 4s -> 8s -> 15s -> 15s...` 无限重复。正的 Provider `Retry-After` 仍然优先。
- `retryQuota`(布尔值,默认 `false`):是否重试欠费(`QUOTA`)错误。
- `retryUnknown`(布尔值,默认 `true`):未知错误是否无限重试。
- `unknownMaxRetries`(整数,默认 `3`):同一模型步骤中连续未知错误的限次上限;模型不存在/未配置错误不使用此上限。

设置服务会持久化插件卡片中的值。点击“恢复默认”会删除用户覆盖,立即回到 schema/Cordis 默认值,无需重启。

本插件作为 Provider `normal` 策略耗尽后的下游兜底,也负责 Provider `always` 委托下来的恢复决定。两层不会叠加成两条重试循环:`normal` 只先处理自身白名单,`always` 直接把决定交给下游。

`maxDelayMs` 只封顶本地指数等待,不封顶 Provider 的 `Retry-After`,也**不是**总重试时长上限。

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
      config:
        maxDelayMs: 15000
        retryQuota: false
        retryUnknown: true
```

非法或缺失的 `maxDelayMs` 值回退为 `60000`。

## 下载方式

本插件与操作系统无关,可以选择以下任意一种方式下载。

### 方式一:GitHub 网页下载

1. 打开 https://github.com/MistRain-1/dsh-reconnect。
2. 点击 **Code**,再点击 **Download ZIP**。
3. 解压后,将 `dsh-reconnect-main` 目录作为插件包使用。

### 方式二:Git 克隆

Windows PowerShell:

```powershell
git clone https://github.com/MistRain-1/dsh-reconnect.git "$HOME\dsh-reconnect"
```

macOS:

```bash
git clone https://github.com/MistRain-1/dsh-reconnect.git "$HOME/dsh-reconnect"
```

Linux:

```bash
git clone https://github.com/MistRain-1/dsh-reconnect.git "$HOME/dsh-reconnect"
```

### 方式三:命令行下载 ZIP

Windows PowerShell:

```powershell
Invoke-WebRequest -Uri https://github.com/MistRain-1/dsh-reconnect/archive/refs/heads/main.zip -OutFile dsh-reconnect.zip
Expand-Archive -Path dsh-reconnect.zip -DestinationPath .
```

macOS:

```bash
curl -L https://github.com/MistRain-1/dsh-reconnect/archive/refs/heads/main.zip -o dsh-reconnect.zip
unzip dsh-reconnect.zip
```

Linux:

```bash
wget https://github.com/MistRain-1/dsh-reconnect/archive/refs/heads/main.zip -O dsh-reconnect.zip
unzip dsh-reconnect.zip
```

下载完成后,将插件加入 DSH 的 Cordis 组合:

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
```

安装持久插件包后需要重启 DSH。

## 运行要求

- DSH Host 端插件
- 使用 `agent/request-error` 瀑布事件和 Host settings 服务
- Client 侧提供统一格式配置卡片,不读取凭据

## License

MIT
