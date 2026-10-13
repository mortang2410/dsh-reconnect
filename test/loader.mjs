// Test bootstrap: register an import map so @deepseek-ai/schemastery resolves
// to the dsh checkout copy, the way the running dsh host's resolver routes
// plugin peer imports to its own packages. Run tests through:
//   node --import ./test/loader.mjs --test test/reconnect.test.js
import { registerHooks } from "node:module";

const HOST = "/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@deepseek-ai/schemastery") {
      return {
        url: `file://${HOST}/schemastery/lib/index.mjs`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
