# dsh-reconnect

> Infinite model-request retry for DeepSeek Harness, with exponential backoff and relay/proxy failure recovery.
>
> 为 DeepSeek Harness 提供模型请求无限重试、指数退避和不稳定中转站/代理恢复能力。

## English

### Project Description

`dsh-reconnect` is a Host-side plugin for DeepSeek Harness (DSH). It retries failed model requests so temporary network failures do not interrupt an agent turn or a long-running task.

The plugin listens to the DSH `agent/request-error` waterfall event. After the built-in finite retry handler gives up, the Agent loop sends the same request again until it succeeds or the user stops the turn.

### Suitable Use Cases

- Unstable relay stations, reverse proxies, API gateways, or forwarding services
- Relay nodes that disconnect, reset connections, or return incomplete responses
- Intermittent network failures and transport errors
- Temporary provider outages, server-side 5xx errors, rate limits, and timeouts
- Long-running tasks that should survive short-lived provider or network failures

### Retry Policy

| Condition | Behavior |
| --- | --- |
| `QUOTA` (insufficient balance or exhausted quota) | Do not retry |
| Any other model-request error | Retry indefinitely until success or cancellation |

Permanent authentication, configuration, or context errors may continue retrying. Stop the current turn manually when such an error cannot recover.

### Backoff and Cancellation

- Exponential backoff: `1s -> 2s -> 4s -> ...`, capped at `60s`
- Honors `providerRetryAfterMs` when available, also capped at `60s`
- Logs the provider, error code, turn, step, retry count, and delay
- Stops when the current turn is aborted or the plugin is stopped

### Installation

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
```

### Runtime Requirements

- Host-side DSH plugin
- `timer` Service and `agent/request-error` waterfall event
- No Client-side UI, external network requests, or credential access

## 中文

### 项目简介

`dsh-reconnect` 是一个 DeepSeek Harness (DSH) Host 端插件。模型请求失败时,插件会自动重新发送请求,避免临时网络故障、中转站不稳定或服务端波动导致 Agent 回合中断。

插件监听 DSH 的 `agent/request-error` 瀑布事件。内置有限重试策略放弃后,Agent 循环会重新发送同一个请求,直到请求成功或用户停止回合。

### 适用场景

- 不稳定的中转站、反向代理、API 网关或转发服务
- 中转节点偶发断开、重置连接或返回不完整响应
- 网络抖动、传输错误和连接超时
- 模型服务临时不可用、5xx 错误、限流或过载
- 需要长时间运行且不能被短暂故障打断的任务

### 重试策略

| 情况 | 处理 |
| --- | --- |
| `QUOTA`(余额不足或额度耗尽) | 不重试 |
| 其他模型请求错误 | 无限重试,直到成功或取消 |

永久性的凭据、配置或上下文错误可能持续重试。遇到无法恢复的错误时,请手动停止当前回合。

### 退避与停止

- 指数退避: `1s -> 2s -> 4s -> ...`,最长等待 `60s`
- 如果服务端提供 `providerRetryAfterMs`,优先使用该等待时间,同样封顶 `60s`
- 记录 Provider、错误码、回合、步骤、重试次数和等待时间
- 用户停止回合或插件停止后立即停止重试

### 安装

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
```

## License

MIT
