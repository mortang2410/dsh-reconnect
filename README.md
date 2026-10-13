# dsh-reconnect (local adaptation)

Safe model-request retry for DeepSeek Harness: retries failed model requests
with exponential backoff so temporary provider failures do not kill an agent
turn.

This is a local adaptation of
[MistRain-1/dsh-reconnect](https://github.com/MistRain-1/dsh-reconnect) 2.0.0
for the dsh `0.2.0-rc.2` host line. The retry policy is upstream v2 semantics,
unchanged.

## Differences from upstream 2.0.0

1. No settings-service import. Upstream imports `settingsNamespace` from
   `@deepseek-ai/dsh-settings`, an export no published dsh-settings version
   provides (checked all versions up to `0.2.1-alpha.1`), and the settings
   service on this host line has no `register` method. Live configuration now
   comes from the Cordis row config (profile patch) only. Change values in
   `cordis.patch.yml` or via the plugin config editor and restart DSH.
2. No client half. Upstream's browser bundle requires
   `@deepseek-ai/dsh-client-web-react` and a `settings.plugin.item` slot;
   neither exists in the `0.2.x` browser shell. There is no settings card; the
   Settings page's plugin inventory still shows the row and its config.
3. Patch dialect. The bundle patch uses the current `insert:` dialect instead
   of the upstream `version:`-nested file.

## Retry policy

| Condition | Behavior |
| --- | --- |
| `EMPTY_RESPONSE` / `RATE_LIMIT` / `SERVER` / `STREAM_CLOSED` / `TIMEOUT` / `TRANSPORT` | Retry indefinitely |
| Model missing or not configured (`MODEL_NOT_FOUND` etc., or matching provider text inside `PI_AI_ERROR`) | Retry indefinitely while waiting for configuration to recover |
| Unknown codes such as `PI_AI_ERROR` | Bounded: up to `unknownMaxRetries` consecutive failures per model step when `retryUnknown: false`; unbounded when `retryUnknown: true` |
| `QUOTA` | Not retried unless `retryQuota: true` |
| Auth / credentials / malformed request / tool error / context overflow / aborted | Never retried |

A provider `Retry-After` is honored as a floor and is not capped by
`maxDelayMs`.

## Configuration

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
      config:
        retryUnknown: false      # bounded unknown-error handling
        unknownMaxRetries: 10    # consecutive unknown failures allowed per step
        retryQuota: false        # quota exhaustion stays non-retryable
        maxDelayMs: 60000        # exponential-backoff cap (1s, 2s, 4s ... 60s)
```

Invalid or missing values fall back to the schema defaults (`maxDelayMs`
60000, `retryQuota` false, `retryUnknown` true, `unknownMaxRetries` 3).

## Install

```sh
dsh plugin --profile web add link:/home/wilder/dsh-test/dsh-reconnect
```

A DSH restart is required after install and after config changes.

## Tests

```sh
npm test
```

The suite covers: transient unbounded retry, the 10-cap on `PI_AI_ERROR`
(including the "Provider returned an empty response" relayed as 502 case),
model-availability exception, permanent/quota non-retry, backoff capping,
Retry-After passthrough, and dispose-drain. The upstream test file is kept at
`test/upstream-reconnect.test.js` as a parity reference only (it exercises the
upstream settings wiring and is not run by `npm test`).

## License

MIT (inherited from upstream).
