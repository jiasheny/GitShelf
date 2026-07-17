/**
 * CLI utilities: config loading, argument parsing, output formatting.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// --- Config ---

function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const repo = String(raw.repo || raw.GITSHELF_REPO || '').trim();
    const token = String(raw.token || raw.GITSHELF_TOKEN || '').trim();
    return raw;
  } catch {
    return {};
  }
}

function getGlobalConfigPath() {
  const configRoot = process.env.XDG_CONFIG_HOME
    || path.join(os.homedir(), '.config');

  if (!configRoot) {
    return '';
  }

  return path.join(configRoot, 'gitshelf', 'config.json');
}

function loadConfig(argv) {
  // 1. Config files
  const rcPath = path.join(process.cwd(), '.gitshelfrc');
  const globalConfig = readConfigFile(getGlobalConfigPath());
  const localConfig = readConfigFile(rcPath);
  const fileConfig = { ...globalConfig, ...localConfig };

  // 2. Environment variables
  const envToken = process.env.GITSHELF_TOKEN || '';
  const envRepo = process.env.GITSHELF_REPO || '';

  // 3. CLI flags
  const token = getFlag(argv, '--token') || envToken || String(fileConfig.token || fileConfig.GITSHELF_TOKEN || '');
  const repo = getFlag(argv, '--repo') || envRepo || String(fileConfig.repo || fileConfig.GITSHELF_REPO || '');
  if (!token) throw new Error('Missing token. Set GITSHELF_TOKEN through your environment or secret store.');
  if (!repo) throw new Error('Missing repo. Set GITSHELF_REPO=owner/name or use --repo.');
  if (!repo.includes('/')) throw new Error('Repo must be in owner/name format.');

  return { token, repo };
}

// --- Arg parsing ---

function getFlag(argv, name) {
  const idx = argv.indexOf(name);
  if (idx === -1) return null;
  return argv[idx + 1] || null;
}

function hasFlag(argv, name) {
  return argv.includes(name);
}

function getPositional(argv, index) {
  // Filter out flags and their values to get positional args
  const positionals = [];
  let skip = false;
  for (const arg of argv) {
    if (skip) { skip = false; continue; }
    if (arg.startsWith('--')) {
      // Flags that take values
      if (['--token', '--repo', '--type', '--title', '--author', '--summary', '--tags', '--visibility'].includes(arg)) {
        skip = true;
      }
      continue;
    }
    positionals.push(arg);
  }
  return positionals[index] || null;
}

function parseItemSelector(selector) {
  const raw = String(selector || '').trim();
  if (!raw) return { id: '', type: '' };

  const separator = raw.indexOf(':');
  if (separator === -1) return { id: raw, type: '' };

  return {
    type: raw.slice(0, separator).trim(),
    id: raw.slice(separator + 1).trim(),
  };
}

function selectCatalogItem(items, selector) {
  const { id, type } = parseItemSelector(selector);
  if (!id) throw new Error('Missing item id.');

  if (type) {
    const index = items.findIndex((item) => String(item.type || 'book') === type && item.id === id);
    if (index === -1) throw new Error(`Item not found: ${selector}`);
    return { item: items[index], index };
  }

  const matches = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.id === id);

  if (matches.length === 0) throw new Error(`Item not found: ${id}`);
  if (matches.length > 1) {
    const selectors = matches.map(({ item }) => `${String(item.type || 'book')}:${item.id}`).join(', ');
    throw new Error(`Multiple items share id "${id}". Use type:id (${selectors}).`);
  }

  return matches[0];
}

// --- Output ---

function jsonOut(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function tableOut(items, columns) {
  if (items.length === 0) {
    console.log('(empty)');
    return;
  }

  // Calculate column widths
  const widths = columns.map((col) => {
    const headerLen = col.header.length;
    const maxVal = items.reduce((max, item) => {
      const val = String(col.value(item) ?? '');
      return Math.max(max, val.length);
    }, 0);
    return Math.max(headerLen, Math.min(maxVal, col.maxWidth || 40));
  });

  // Header
  const header = columns.map((col, i) => col.header.padEnd(widths[i])).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  console.log(header);
  console.log(separator);

  // Rows
  for (const item of items) {
    const row = columns.map((col, i) => {
      let val = String(col.value(item) ?? '');
      if (val.length > widths[i]) val = val.slice(0, widths[i] - 1) + '\u2026';
      return val.padEnd(widths[i]);
    }).join('  ');
    console.log(row);
  }
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

module.exports = {
  getGlobalConfigPath,
  loadConfig,
  getFlag,
  hasFlag,
  getPositional,
  parseItemSelector,
  selectCatalogItem,
  jsonOut,
  tableOut,
  die,
};
