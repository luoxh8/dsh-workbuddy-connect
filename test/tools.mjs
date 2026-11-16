/**
 * Registration test: mount the three tools on a fake context, then re-validate
 * every schema with the real validator from the installed harness, so a schema
 * drift fails here instead of at DSH startup.
 *
 * Run with: node test/tools.mjs
 */

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as plugin from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const registered = [];

const ctx = {
  inject(services, run) {
    if (!Array.isArray(services) || !services.includes('tools')) {
      throw new Error(`unexpected inject: ${JSON.stringify(services)}`);
    }
    run({
      tools: {
        register(definition) {
          registered.push(definition);
          return () => {};
        },
      },
    });
  },
};

plugin.apply(ctx, {});
if (plugin.name !== 'workbuddy-growth') throw new Error('plugin name drifted');
if (!Array.isArray(plugin.inject) || !plugin.inject.includes('tools')) throw new Error('inject drifted');
if (registered.length !== 3) throw new Error(`expected 3 tools, got ${registered.length}`);

for (const tool of registered) {
  if (typeof tool.description !== 'string' || tool.description === '') throw new Error(`${tool.name} has no description`);
  if (typeof tool.output?.render !== 'function') throw new Error(`${tool.name} has no output.render`);
  if (tool.output.schema === undefined) throw new Error(`${tool.name} has no output.schema`);
}

// The real validator, when the harness can be resolved from this Node build.
let assertSupportedJsonSchema;
try {
  const require = createRequire(import.meta.url);
  const installDir = process.env['DSH_INSTALL_DIR'];
  if (installDir === undefined || installDir === '') throw new Error('DSH_INSTALL_DIR is not set');
  const spec = require.resolve('@deepseek-ai/dsh-tools', { paths: [installDir] });
  ({ assertSupportedJsonSchema } = await import(`file:///${spec.replaceAll('\\', '/')}`));
} catch (error) {
  console.log(`skipped schema validation: ${String(error.message ?? error)}`);
}

if (assertSupportedJsonSchema !== undefined) {
  for (const tool of registered) {
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
  }
  console.log('schemas validated by @deepseek-ai/dsh-tools');
}

for (const tool of registered) console.log(`ok ${tool.name}`);
console.log(`done (${resolve(here, '..')})`);
