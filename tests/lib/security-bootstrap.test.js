import { beforeEach, describe, expect, it } from 'vitest';
import { clearLegacyCredentials } from '../../src/lib/security-bootstrap';

describe('security bootstrap', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('removes legacy credentials before the admin route is opened', () => {
    localStorage.setItem('github_pat', 'old-local-token');
    sessionStorage.setItem('github_pat', 'old-session-token');

    clearLegacyCredentials();

    expect(localStorage.getItem('github_pat')).toBeNull();
    expect(sessionStorage.getItem('github_pat')).toBeNull();
  });
});
