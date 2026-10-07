import { describe, expect, it } from 'vitest';
import { serverUrlFrom } from '../../src';

describe('server address typed on the "enroll this PC" screen', () => {
  it('becomes an HTTPS address with the default port', () => {
    expect(serverUrlFrom('artepool-server')).toBe('https://artepool-server:3100');
    expect(serverUrlFrom(' 192.168.1.10 ')).toBe('https://192.168.1.10:3100');
    expect(serverUrlFrom('192.168.1.10:4000')).toBe('https://192.168.1.10:4000');
    expect(serverUrlFrom('https://artepool-server:3100/')).toBe('https://artepool-server:3100');
    expect(serverUrlFrom('[::1]:3100')).toBe('https://[::1]:3100');
  });

  it('refuses anything that is not a plain HTTPS server address', () => {
    for (const bad of [
      '',
      'http://artepool-server',
      'ftp://x',
      'https://user:pass@server',
      'https://server/path',
      'https://server?x=1',
      'two words',
    ]) {
      expect(serverUrlFrom(bad), bad).toBeNull();
    }
  });
});
