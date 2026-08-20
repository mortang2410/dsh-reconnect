import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

afterEach(() => {
  delete globalThis.window;
});

describe("ReConnect 客户端设置卡片", () => {
  it("注册到宿主插件配置页，并绑定 dsh-reconnect settings namespace", async () => {
    let clientPlugin;
    globalThis.window = {
      __ModuleLoader__: {
        load({ factory }) {
          const module = { exports: {} };
          clientPlugin = factory((id) => {
            if (id === "@deepseek-ai/dsh-client-web-react") {
              return { bindSnapshotSelector: () => () => ({ status: "loading" }) };
            }
            return {};
          }, module, module.exports);
        },
      },
    };

    await import(`../src/client.js?test=${Date.now()}`);

    let registeredOptions;
    const ctx = {
      slots: {
        inject(name, register) {
          assert.equal(name, "settings.plugin.item");
          register();
        },
        register(options) {
          if (options.name === "settings.plugin.item" && !options.key) {
            throw new Error('keyed slot "settings.plugin.item" requires options.key');
          }
          registeredOptions = options;
        },
      },
      settingsScope: {
        bind(options) {
          assert.deepEqual(options, { namespace: "dsh-reconnect" });
          return { getSnapshot() {}, set() {}, unset() {} };
        },
      },
    };

    clientPlugin.apply(ctx);
    assert.deepEqual({
      name: "settings.plugin.item",
      key: "dsh-reconnect",
    }, {
      name: registeredOptions.name,
      key: registeredOptions.key,
    });
    assert.equal(typeof registeredOptions.inject, "function");
    assert.deepEqual(clientPlugin.inject, ["slots", "settingsScope"]);
  });
});
