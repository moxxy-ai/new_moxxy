import { describe, expect, it } from 'vitest';
import { formatPluginsList } from './plugins.js';

describe('formatPluginsList', () => {
  it('includes pure ui plugin metadata with port and package path', () => {
    const text = formatPluginsList({
      runtime: [{ name: '@moxxy/tools-builtin', version: '0.0.0', loaded: true }],
      ui: [
        {
          packageName: '@moxxy/virtual-office-plugin',
          packageVersion: '0.0.7',
          packagePath: '/tmp/plugins/@moxxy/virtual-office-plugin',
          entry: './serve.js',
          kind: 'ui',
          port: 17901,
        },
      ],
    });

    expect(text).toContain('@moxxy/tools-builtin');
    expect(text).toContain('@moxxy/virtual-office-plugin');
    expect(text).toContain('ui:17901');
    expect(text).toContain('/tmp/plugins/@moxxy/virtual-office-plugin');
  });
});
