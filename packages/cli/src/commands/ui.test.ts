import { describe, expect, it } from 'vitest';
import { formatUiList } from './ui.js';

describe('formatUiList', () => {
  it('renders an empty hint when no UI plugins are installed', () => {
    const text = formatUiList([]);
    expect(text).toContain('no UI plugins installed');
  });

  it('renders package name, port, and title for each UI plugin', () => {
    const text = formatUiList([
      {
        packageName: '@moxxy/virtual-office-plugin',
        packageVersion: '0.0.7',
        packagePath: '/tmp/plugins/@moxxy/virtual-office-plugin',
        entry: './serve.js',
        kind: 'ui',
        port: 17901,
        title: 'Virtual Office',
      },
    ]);
    expect(text).toContain('@moxxy/virtual-office-plugin');
    expect(text).toContain('ui:17901');
    expect(text).toContain('Virtual Office');
  });
});
