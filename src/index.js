import z from "@deepseek-ai/schemastery";

/**
 * ReConnect — 模型请求失败自动恢复(Host half)。
 *
 * 本地适配版:基于 MistRain-1/dsh-reconnect 2.0.0,适配 dsh 0.2.0-rc.2。
 * 与上游的差异仅在配置来源:已发布的 @deepseek-ai/dsh-settings 没有
 * settingsNamespace API,settings 服务也不提供 ctx.settings.register,
 * 因此这里删除了 settings 注册层,实时配置直接来自 Cordis 行配置
 * (profile patch,可在 Settings 的插件配置编辑器或 cordis.patch.yml 修改,
 * 重启生效)。
 *
 * 只处理 agent/request-error 中的模型请求失败。工具执行结果属于
 * tool/result,不在本插件的重试边界内;模型不存在或模型未配置属于
 * 等待配置恢复的例外。
 */
export const name = "reconnect";
export const inject = [];

const DEFAULTS = Object.freeze({
  maxDelayMs: 60000,
  retryQuota: false,
  retryUnknown: true,
  unknownMaxRetries: 3,
});

export const Config = z.object({
  maxDelayMs: z.number().step(1).min(1000).max(2147483647).default(DEFAULTS.maxDelayMs),
  retryQuota: z.boolean().default(DEFAULTS.retryQuota),
  retryUnknown: z.boolean().default(DEFAULTS.retryUnknown),
  unknownMaxRetries: z.number().step(1).min(0).max(100).default(DEFAULTS.unknownMaxRetries),
});

// DSH 模型层标记的临时错误集合;STREAM_CLOSED 是异常流结束的传输类扩展。
const TRANSIENT_CODES = new Set([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "STREAM_CLOSED",
  "TIMEOUT",
  "TRANSPORT",
]);

// 明确属于修复请求/执行环境的问题,不能靠重复同一个请求解决。
const PERMANENT_CODES = new Set([
  "ABORTED",
  "ABORTED_BEFORE_DISPATCH",
  "AUTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "INVALID_ARGS",
  "INVALID_CREDENTIAL",
  "INVALID_REQUEST",
  "INVALID_REPLAY_STATE",
  "MISSING_CREDENTIAL",
  "NO_ADAPTER",
  "NO_TOOL",
  "UNKNOWN_TOOL",
  "UNSUPPORTED_CONTENT",
  "UNSUPPORTED_OPTION",
  "UNSUPPORTED_REASONING_EFFORT",
]);

const TOOL_ERROR_CODES = new Set([
  "TOOL_ERROR",
  "TOOL_OUTPUT_ERROR",
  "TOOL_EXECUTION_ERROR",
  "TOOL_CALL_ERROR",
]);

// 模型不存在或当前 Provider 没有配置该模型时,允许无限重试等待配置恢复。
const MODEL_AVAILABILITY_CODES = new Set([
  "MODEL_NOT_FOUND",
  "MODEL_NOT_EXIST",
  "MODEL_NOT_EXISTS",
  "MODEL_NOT_CONFIGURED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_UNAVAILABLE",
  "NO_MODEL",
  "UNKNOWN_MODEL",
]);

// pi-ai 会把部分 404 模型路由错误压成 PI_AI_ERROR,只能从其稳定的
// provider 错误片段识别;不要把所有 PI_AI_ERROR 都当成模型可用性错误。
const MODEL_AVAILABILITY_MESSAGE_PATTERNS = [
  /\bmodel[_ -]?not[_ -]?found\b/i,
  /\bmodel[_ -]?not[_ -]?(?:configured|available|exist(?:s)?)\b/i,
  /\bmodel\b[^\r\n]{0,120}\b(?:not found|not available|unavailable)\b/i,
  /\bunknown model\b/i,
  /\bno configured model\b/i,
  /\bno model(?: is)? configured\b/i,
  /\bno such model\b/i,
  /\bmodel\b[^\r\n]{0,120}\b(?:does not exist|doesn't exist|is not supported by any configured account|is not configured|isn't configured|not configured)\b/i,
  /(?:模型不存在|模型未配置|未配置模型)/i,
];

function normalizeConfig(value = {}) {
  const maxDelayMs = Number.isSafeInteger(value.maxDelayMs) && value.maxDelayMs >= 1000
    ? Math.min(value.maxDelayMs, 2147483647)
    : DEFAULTS.maxDelayMs;
  const unknownMaxRetries = Number.isSafeInteger(value.unknownMaxRetries) && value.unknownMaxRetries >= 0
    ? Math.min(value.unknownMaxRetries, 100)
    : DEFAULTS.unknownMaxRetries;
  return {
    maxDelayMs,
    retryQuota: value.retryQuota === undefined ? DEFAULTS.retryQuota : value.retryQuota === true,
    retryUnknown: value.retryUnknown === undefined ? DEFAULTS.retryUnknown : value.retryUnknown === true,
    unknownMaxRetries,
  };
}

function messageOf(failure) {
  return failure && typeof failure.message === "string" ? failure.message : "";
}

function isModelAvailabilityFailure(failure, code) {
  if (typeof code === "string" && MODEL_AVAILABILITY_CODES.has(code.toUpperCase())) return true;
  if (typeof code !== "string" || code.toUpperCase() !== "PI_AI_ERROR") return false;
  return MODEL_AVAILABILITY_MESSAGE_PATTERNS.some((pattern) => pattern.test(messageOf(failure)));
}

function isPermanentFailure(failure, code) {
  if (isModelAvailabilityFailure(failure, code)) return false;
  return PERMANENT_CODES.has(code) || TOOL_ERROR_CODES.has(code);
}

function copyFailure(failure, code) {
  const snapshot = {
    code,
    message: messageOf(failure) || code,
  };
  if (failure && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599) {
    snapshot.status = failure.status;
  }
  if (failure && typeof failure.providerRetryAfterMs === "number"
    && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
    snapshot.providerRetryAfterMs = failure.providerRetryAfterMs;
  }
  if (failure && typeof failure.requestId === "string" && failure.requestId.length > 0) {
    snapshot.requestId = failure.requestId;
  }
  return snapshot;
}

/** 从 durable 会话事件恢复本插件指定策略链的最后一次重试。 */
function previousRetry(session, turn, step, provider, policyKey) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event && event.type === "llm/retry" ? event.data : undefined;
    if (data && data.turn === turn && data.step === step && data.provider === provider
      && data.policyKey === policyKey) {
      return data;
    }
  }
  return undefined;
}

function previousPluginRetryInScope(session, turn, step, provider) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event && event.type === "llm/retry" ? event.data : undefined;
    if (!sameRetryScope(data, turn, step, provider)) continue;
    return isPluginRetryData(data, turn, step, provider) ? data : undefined;
  }
  return undefined;
}

function sameRetryScope(data, turn, step, provider) {
  return data && data.turn === turn && data.step === step && data.provider === provider;
}

function isPluginRetryData(data, turn, step, provider) {
  return sameRetryScope(data, turn, step, provider)
    && typeof data.policyKey === "string" && data.policyKey.startsWith("reconnect-");
}

function isBoundedUnknownFailure(failure, code) {
  return typeof code === "string"
    && !TRANSIENT_CODES.has(code)
    && code !== "QUOTA"
    && !isModelAvailabilityFailure(failure, code);
}

/** 统计同一模型步骤中最后一段连续未知错误,避免错误码抖动制造假上限。 */
function previousUnknownStreak(session, turn, step, provider) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return 0;
  let streak = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "llm/retry") continue;
    const data = event.data;
    if (!sameRetryScope(data, turn, step, provider)) continue;
    if (!isPluginRetryData(data, turn, step, provider)) break;
    if (typeof data.policyKey !== "string" || !data.policyKey.startsWith("reconnect-unknown-normal-v4:")) break;
    const code = data.failure && typeof data.failure.code === "string" ? data.failure.code : "UNKNOWN";
    if (!isBoundedUnknownFailure(data.failure, code)) break;
    streak += 1;
  }
  return streak;
}

/** 返回同一错误类别的策略;有限未知链的 policyKey 在调用点按连续段生成。 */
function retryPolicyFor(code, retryUnknown, failure) {
  if (isModelAvailabilityFailure(failure, code)) {
    return { key: "reconnect-model-availability-v4", mode: "always" };
  }
  if (code === "QUOTA") {
    return { key: "reconnect-quota-v3", mode: "always" };
  }
  if (TRANSIENT_CODES.has(code)) {
    return { key: "reconnect-transient-v3", mode: "always" };
  }
  return retryUnknown
    ? { key: "reconnect-unknown-always-v3", mode: "always" }
    : { key: "reconnect-unknown-normal-v3", mode: "normal" };
}

function backoffDelay(retry, maxDelayMs) {
  const exponent = Math.min(Math.max(retry - 1, 0), 31);
  return Math.min(maxDelayMs, 1000 * (2 ** exponent));
}

function providerRetryAfter(failure) {
  if (!failure || typeof failure.providerRetryAfterMs !== "number"
    || !Number.isFinite(failure.providerRetryAfterMs) || failure.providerRetryAfterMs <= 0) {
    return undefined;
  }
  return Math.min(Math.ceil(failure.providerRetryAfterMs), 2147483647);
}

/** 创建同时受回合和插件生命周期控制的退避等待。 */
function waitForRetry(delayMs, signals) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    if (signals.some((signal) => signal?.aborted)) {
      finish();
      return;
    }
    for (const signal of signals) signal?.addEventListener?.("abort", finish, { once: true });
    timer = setTimeout(finish, delayMs);
  });
}

/** 安装 Host 重试监听器(配置仅来自 Cordis 行配置)。 */
export function apply(ctx, config = {}) {
  const live = normalizeConfig(config);
  const lifetime = new AbortController();
  const active = new Set();
  let alive = true;

  function nextRetryId() {
    return `reconnect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function track(operation) {
    active.add(operation);
    const remove = () => active.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  ctx.effect(() => {
    const disposers = [];

    const handleRequestError = async (payload, next) => {
      const { agent, turn, step, provider, failure, signal } = payload;
      const code = failure && typeof failure.code === "string" ? failure.code : "UNKNOWN";
      const message = messageOf(failure);

      if (!alive || signal?.aborted) return next();
      // llm-retry 的 always 实现会把恢复决定交给下游 waterfall;
      // 本插件是该链的下游恢复者,不能把普通可恢复错误直接交回终点。
      if (isPermanentFailure(failure, code)) return next();
      if (code === "QUOTA" && !live.retryQuota) return next();

      const unknown = isBoundedUnknownFailure(failure, code);
      const policy = retryPolicyFor(code, live.retryUnknown, failure);
      const prior = previousRetry(agent.session, turn, step, provider, policy.key);
      const unknownStreak = unknown ? previousUnknownStreak(agent.session, turn, step, provider) : 0;
      if (unknown && !live.retryUnknown && unknownStreak >= live.unknownMaxRetries) {
        console.warn(`[ReConnect] ${provider} ${code} 达到未知错误重试上限(${live.unknownMaxRetries}),停止本链${message ? `: ${message.slice(0, 160)}` : ""}`);
        return next();
      }
      let retryPolicyForRequest = policy;
      let retryPrior = prior;
      if (unknown && !live.retryUnknown) {
        const last = previousPluginRetryInScope(agent.session, turn, step, provider);
        const lastCode = last?.failure && typeof last.failure.code === "string"
          ? last.failure.code
          : "UNKNOWN";
        const sameBoundedSegment = Boolean(last)
          && isBoundedUnknownFailure(last.failure, lastCode)
          && typeof last.policyKey === "string"
          && last.policyKey.startsWith("reconnect-unknown-normal-v4:");
        // 有限未知重试只延续最后一段未知错误;中间出现其他策略后从新的 1/N 链开始。
        if (sameBoundedSegment) {
          retryPolicyForRequest = { ...policy, key: last.policyKey };
          retryPrior = last;
        } else {
          retryPolicyForRequest = { ...policy, key: `reconnect-unknown-normal-v4:${nextRetryId()}` };
          retryPrior = undefined;
        }
      }
      const retryPreviousCount = retryPrior && Number.isSafeInteger(retryPrior.retry) && retryPrior.retry >= 0
        ? retryPrior.retry
        : 0;
      const retry = retryPreviousCount >= Number.MAX_SAFE_INTEGER ? retryPreviousCount : retryPreviousCount + 1;
      const retryId = retryPrior && typeof retryPrior.retryId === "string" && retryPrior.retryId.length > 0
        ? retryPrior.retryId
        : nextRetryId();
      const maxDelayMs = live.maxDelayMs;
      const waitMs = providerRetryAfter(failure) ?? backoffDelay(retry, maxDelayMs);
      const retryMode = retryPolicyForRequest.mode;

      agent.session.append("llm/retry", {
        retryId,
        turn,
        step,
        provider,
        mode: retryMode,
        ...(retryMode === "normal" ? { maxRetries: live.unknownMaxRetries } : {}),
        policyKey: retryPolicyForRequest.key,
        retry,
        delayMs: waitMs,
        failure: copyFailure(failure, code),
      });
      console.log(`[ReConnect] ${provider} ${code} 第${retry}次失败 → ${waitMs}ms 后重试 (turn ${turn} step ${step}, maxDelayMs=${maxDelayMs})`);

      await waitForRetry(waitMs, [signal, lifetime.signal]);

      if (!alive || signal?.aborted || lifetime.signal.aborted) return next();
      agent.session.append("llm/retry-started", {
        retryId,
        turn,
        step,
        retry,
      });
      return { kind: "retry" };
    };

    disposers.push(ctx.on("agent/request-error", (payload, next) => {
      return track(Promise.resolve(handleRequestError(payload, next)));
    }));

    return () => {
      alive = false;
      lifetime.abort();
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
      return Promise.allSettled([...active]);
    };
  }, "reconnect: safe model-request recovery");
}
