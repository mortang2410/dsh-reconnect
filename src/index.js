/**
 * ReConnect — 模型请求失败自动无限重试插件(Host half)。
 *
 * 原理:DSH 每次流式模型调用失败都会派发 `agent/request-error` 瀑布事件;
 * 监听器返回 `{ kind: 'retry' }` 且不调用 `next()` 时,Agent 循环会原地重发
 * 这次请求。本插件注册在瀑布末端做兜底:内置 llm-retry 的有限重试(默认 2 次,
 * 仅限 RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE)放弃后,由我们
 * 接管,对除欠费(QUOTA)以外的所有错误无限重试,直到成功或用户中止回合。
 *
 * 退避:指数退避(1s → 2s → 4s → ... 封顶 60s),服务端 Retry-After 优先;
 * 尊重回合的中止信号与插件自身的停止信号。
 */
export const name = 'reconnect';

/** 需要 timer 服务提供可取消的退避等待。 */
export const inject = ['timer'];

/**
 * @param {import('cordis').Context} ctx
 */
export function apply(ctx) {
  const INITIAL_DELAY_MS = 1000;
  const MAX_DELAY_MS = 60000;
  // 插件停止标志:停止后不再安排新重试。
  let alive = true;
  // agent 对象 -> Map(turn:step -> { count, delay });WeakMap 随 agent 回收自动清理。
  const byAgent = new WeakMap();

  // 插件生命周期:停止时关闭标志并卸载监听器。
  ctx.effect(() => {
    const disposeListener = ctx.on('agent/request-error', async (payload, next) => {
      const { agent, turn, step, provider, failure, signal } = payload;
      const code = failure && typeof failure.code === 'string' ? failure.code : 'UNKNOWN';

      // 欠费不重试,交还瀑布默认行为(终结错误)。
      if (code === 'QUOTA') return next();
      // 用户中止回合或插件已停止:立即停止重试。
      if (signal.aborted || !alive) return next();

      // 按 (turn, step) 追踪本次请求的连续失败次数与上一轮延迟。
      let byStep = byAgent.get(agent);
      if (byStep === undefined) {
        byStep = new Map();
        byAgent.set(agent, byStep);
      }
      const key = `${turn}:${step}`;
      let entry = byStep.get(key);
      if (entry === undefined) {
        entry = { count: 0, delay: 0 };
        byStep.set(key, entry);
      }
      entry.count += 1;
      const nextDelay = entry.delay <= 0
        ? INITIAL_DELAY_MS
        : entry.delay * 2 > MAX_DELAY_MS ? MAX_DELAY_MS : entry.delay * 2;
      entry.delay = nextDelay;

      // 服务端 Retry-After 优先(封顶 60s)。
      let waitMs = nextDelay;
      if (failure && typeof failure.providerRetryAfterMs === 'number'
        && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
        waitMs = failure.providerRetryAfterMs > MAX_DELAY_MS ? MAX_DELAY_MS : failure.providerRetryAfterMs;
      }

      console.log(`[ReConnect] ${provider} ${code} 第${entry.count}次失败 → ${waitMs}ms 后重试 (turn ${turn} step ${step})`);

      // 可中止等待:回合中止信号触发时提前结束等待。
      await new Promise((resolve) => {
        let settled = false;
        let disposeTimer = null;
        const onAbort = () => finish();
        const finish = () => {
          if (settled) return;
          settled = true;
          if (disposeTimer) {
            try { disposeTimer(); } catch (err) { /* 定时器已解除 */ }
          }
          try { signal.removeEventListener('abort', onAbort); } catch (err) { /* 忽略 */ }
          resolve();
        };
        try { signal.addEventListener('abort', onAbort, { once: true }); } catch (err) { /* 忽略 */ }
        disposeTimer = ctx.timeout(finish, waitMs);
      });

      // 等待期间被中止或插件被停止:交还瀑布(终结错误),不安排重试。
      if (signal.aborted || !alive) return next();
      // 接管恢复:让 Agent 循环原地重发这次请求。
      return { kind: 'retry' };
    });

    return () => {
      alive = false;
      disposeListener();
    };
  }, 'reconnect: infinite request retry');
}