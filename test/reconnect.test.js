import { describe, it } from "node:test";
import assert from "node:assert/strict";
// Neutralize real backoff waits BEFORE importing the plugin: record scheduled
// timers and fire them immediately, so backoff chains proceed without wall time.
const pendingTimers = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  pendingTimers.push(fn);
  return { unref() {}, ref() {} };
};
function drainTimers() {
  while (pendingTimers.length > 0) {
    const fn = pendingTimers.shift();
    fn();
  }
}
import { apply, Config } from "../src/index.js";

function createHarness(config = {}) {
  const listeners = new Map();
  let cleanup;
  const currentConfig = {
    maxDelayMs: 1000,
    retryQuota: false,
    retryUnknown: false,
    unknownMaxRetries: 10,
    ...config,
  };
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(factory) {
      cleanup = factory();
    },
  };
  apply(ctx, currentConfig);
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const agent = { session };
  const signal = new AbortController();
  const requestError = async (failure, extra = {}) => {
    // The handler awaits a backoff timer before returning; fire the pending
    // timer while the handler is pending, then await its result.
    const pending = listeners.get("agent/request-error")({
      agent,
      turn: 1,
      step: 1,
      provider: "fixture",
      failure,
      signal: extra.signal || signal.signal,
      retryPolicy: extra.retryPolicy,
    }, () => ({ kind: "next" }));
    drainTimers();
    return await pending;
  };
  return {
    agent,
    session,
    signal,
    requestError,
    async dispose() {
      await cleanup?.();
    },
  };
}

function failure(code, providerRetryAfterMs = 0, message = "fixture failure") {
  return {
    code,
    message,
    ...(providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
  };
}

describe("ReConnect 本地适配版重试策略", () => {
  it("Config schema 默认值为上游 v2 缺省", () => {
    assert.deepEqual(Config({}), {
      maxDelayMs: 60000,
      retryQuota: false,
      retryUnknown: true,
      unknownMaxRetries: 3,
    });
  });

  it("对临时错误重试并使用 durable 事件恢复计数", async () => {
    const harness = createHarness();

    const first = await harness.requestError(failure("SERVER"));
    assert.deepEqual(first, { kind: "retry" });
    const second = await harness.requestError(failure("RATE_LIMIT"));
    assert.deepEqual(second, { kind: "retry" });
    const third = await harness.requestError(failure("STREAM_CLOSED"));
    assert.deepEqual(third, { kind: "retry" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3]);
    assert.equal(retries[0].data.policyKey, "reconnect-transient-v3");
    assert.equal(retries[0].data.retryId, retries[1].data.retryId);
    assert.equal(retries[1].data.retryId, retries[2].data.retryId);
    await harness.dispose();
  });

  it("profile 配置:PI_AI_ERROR 限次 10,第 11 次连续失败交回 next", async () => {
    const harness = createHarness();

    for (let retry = 1; retry <= 10; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(retries[0].data.mode, "normal");
    assert.equal(retries[0].data.maxRetries, 10);
    assert.match(retries[0].data.policyKey, /^reconnect-unknown-normal-v4:/);
    await harness.dispose();
  });

  it("空响应消息若被压成 PI_AI_ERROR 仍走有限未知链(等待配置恢复的措辞除外)", async () => {
    const harness = createHarness();
    const empty = failure(
      "PI_AI_ERROR",
      0,
      'This turn failed400: {"code":"502","message":"Provider returned an empty response"}',
    );

    for (let retry = 1; retry <= 10; retry += 1) {
      assert.deepEqual(await harness.requestError(empty), { kind: "retry" });
    }
    assert.deepEqual(await harness.requestError(empty), { kind: "next" });
    await harness.dispose();
  });

  it("模型不存在/未配置错误(含 PI_AI_ERROR 文本变体)无限重试,不受 10 次上限约束", async () => {
    const cases = [
      failure("MODEL_NOT_FOUND", 0),
      failure("UNKNOWN_MODEL", 0),
      failure(
        "PI_AI_ERROR",
        0,
        'OpenAI API error (404): {"message":"Model \\"gpt-5.6-luna\\" is not supported by any configured account in this group","type":"model_not_found"}',
      ),
      failure("PI_AI_ERROR", 0, 'model "gpt-5.6-luna" is not configured for this account'),
      failure("PI_AI_ERROR", 0, "no model configured for this account"),
    ];

    for (const modelFailure of cases) {
      const harness = createHarness();
      for (let retry = 1; retry <= 11; retry += 1) {
        assert.deepEqual(await harness.requestError(modelFailure), { kind: "retry" });
      }
      const retries = harness.session.events.filter((event) => event.type === "llm/retry");
      assert.equal(retries[0].data.mode, "always");
      assert.equal(retries[0].data.policyKey, "reconnect-model-availability-v4");
      assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
      await harness.dispose();
    }
  });

  it("未知错误上限只统计连续未知失败,临时错误会重新打开兜底窗口", async () => {
    const harness = createHarness({ unknownMaxRetries: 2 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("SERVER")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 1, 1]);
    assert.equal(retries[0].data.policyKey, retries[1].data.policyKey);
    assert.notEqual(retries[0].data.policyKey, retries[3].data.policyKey);
    await harness.dispose();
  });

  it("retryUnknown 为 true 时未知错误无限重试", async () => {
    const harness = createHarness({ retryUnknown: true });

    for (let retry = 1; retry <= 4; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.equal(retries[0].data.mode, "always");
    assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
    await harness.dispose();
  });

  it("unknownMaxRetries 为零时不创建重试事件", async () => {
    const harness = createHarness({ retryUnknown: false, unknownMaxRetries: 0 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("永久错误和默认配额错误不重试", async () => {
    const harness = createHarness();

    for (const code of [
      "AUTH",
      "INVALID_CREDENTIAL",
      "MISSING_CREDENTIAL",
      "INVALID_REQUEST",
      "INVALID_REPLAY_STATE",
      "CONTEXT_WINDOW_EXCEEDED",
      "ABORTED",
      "TOOL_ERROR",
      "UNKNOWN_TOOL",
      "UNSUPPORTED_OPTION",
      "UNSUPPORTED_REASONING_EFFORT",
    ]) {
      assert.deepEqual(await harness.requestError(failure(code)), { kind: "next" });
    }
    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("配额开关开启后使用无限策略", async () => {
    const harness = createHarness({ retryQuota: true });

    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "retry" });
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.mode, "always");
    assert.equal(event.data.policyKey, "reconnect-quota-v3");
    await harness.dispose();
  });

  it("完整尊重 Provider Retry-After,不被本地指数上限截断", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const pending = harness.requestError(failure("SERVER", 120000));
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.delayMs, 120000);
    harness.signal.abort();
    assert.deepEqual(await pending, { kind: "next" });
    await harness.dispose();
  });

  it("指数退避封顶 maxDelayMs(60s 配置)", async () => {
    const harness = createHarness({ maxDelayMs: 60000 });

    for (let retry = 1; retry <= 8; retry += 1) {
      await harness.requestError(failure("EMPTY_RESPONSE"));
      const event = harness.session.events.filter((item) => item.type === "llm/retry").at(-1).data;
      assert.equal(event.delayMs, Math.min(60000, 1000 * 2 ** (retry - 1)));
    }
    await harness.dispose();
  });

  it("插件销毁会取消退避,不会留下悬挂 Promise", async () => {
    const harness = createHarness();
    const pending = harness.requestError(failure("SERVER", 2147483647));

    await harness.dispose();
    assert.deepEqual(await pending, { kind: "next" });
  });
});
