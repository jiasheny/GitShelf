/* @vitest-environment node */

import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

const { getGlobalConfigPath, loadConfig, selectCatalogItem } = require('../../cli/util.js');
const originalEnv = { ...process.env };
const originalCwd = process.cwd();

function createIsolatedConfigHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gitshelf-cli-test-'));
}

afterEach(() => {
  process.env = { ...originalEnv };
  process.chdir(originalCwd);
});

describe('cli item selectors', () => {
  it('resolves an item by unique id', () => {
    const items = [
      { id: 'alpha', type: 'book' },
      { id: 'beta', type: 'doc' },
    ];

    expect(selectCatalogItem(items, 'beta')).toEqual({
      item: items[1],
      index: 1,
    });
  });

  it('resolves a duplicated id by explicit type selector', () => {
    const items = [
      { id: 'shared', type: 'book' },
      { id: 'shared', type: 'doc' },
    ];

    expect(selectCatalogItem(items, 'doc:shared')).toEqual({
      item: items[1],
      index: 1,
    });
  });

  it('throws a helpful error for ambiguous ids', () => {
    const items = [
      { id: 'shared', type: 'book' },
      { id: 'shared', type: 'site' },
    ];

    expect(() => selectCatalogItem(items, 'shared')).toThrow(
      'Multiple items share id "shared". Use type:id (book:shared, site:shared).',
    );
  });
});

describe('cli config loading', () => {
  it('reads token from GITSHELF_TOKEN', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      GITSHELF_TOKEN: 'token-from-env',
      GITSHELF_REPO: 'owner/repo',
    };

    expect(loadConfig([])).toEqual({
      token: 'token-from-env',
      repo: 'owner/repo',
    });
  });

  it('does not fall back to GITHUB_TOKEN', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      GITHUB_TOKEN: 'generic-token',
      GITSHELF_REPO: 'owner/repo',
    };

    expect(() => loadConfig([])).toThrow('Missing token. Set GITSHELF_TOKEN through your environment or secret store.');
  });

  it('reads repo and token from ~/.config/gitshelf/config.json when env is absent', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
    };
    fs.mkdirSync(path.dirname(getGlobalConfigPath()), { recursive: true });
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({
      repo: 'owner/repo',
      token: 'token-from-config',
    }));

    expect(loadConfig([])).toEqual({
      token: 'token-from-config',
      repo: 'owner/repo',
    });
  });

  it('accepts legacy uppercase keys in config files', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
    };
    fs.mkdirSync(path.dirname(getGlobalConfigPath()), { recursive: true });
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({
      GITSHELF_REPO: 'owner/repo',
      GITSHELF_TOKEN: 'token-from-uppercase-config',
    }));

    expect(loadConfig([])).toEqual({
      token: 'token-from-uppercase-config',
      repo: 'owner/repo',
    });
  });

  it('lets local .gitshelfrc override the global config file', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
    };
    fs.mkdirSync(path.dirname(getGlobalConfigPath()), { recursive: true });
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({
      repo: 'global-owner/global-repo',
      token: 'token-from-global-config',
    }));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitshelf-project-test-'));
    fs.writeFileSync(path.join(projectDir, '.gitshelfrc'), JSON.stringify({
      repo: 'local-owner/local-repo',
      token: 'token-from-local-rc',
    }));
    process.chdir(projectDir);

    expect(loadConfig([])).toEqual({
      token: 'token-from-local-rc',
      repo: 'local-owner/local-repo',
    });
  });

  it('lets env override config files', () => {
    const tempDir = createIsolatedConfigHome();
    process.env = {
      ...originalEnv,
      XDG_CONFIG_HOME: tempDir,
      GITSHELF_TOKEN: 'token-from-env',
      GITSHELF_REPO: 'env-owner/env-repo',
    };
    fs.mkdirSync(path.dirname(getGlobalConfigPath()), { recursive: true });
    fs.writeFileSync(getGlobalConfigPath(), JSON.stringify({
      repo: 'global-owner/global-repo',
      token: 'token-from-global-config',
    }));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitshelf-project-test-'));
    fs.writeFileSync(path.join(projectDir, '.gitshelfrc'), JSON.stringify({
      repo: 'ignored-owner/ignored-repo',
      token: 'ignored-token',
    }));
    process.chdir(projectDir);

    expect(loadConfig([])).toEqual({
      token: 'token-from-env',
      repo: 'env-owner/env-repo',
    });
  });
});
