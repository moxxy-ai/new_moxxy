import { definePlugin } from './define.js';

// @ts-expect-error dependsOn was replaced by requirements and is no longer part of PluginSpec.
definePlugin({ name: 'legacy-dependency-plugin', dependsOn: ['base'] });
