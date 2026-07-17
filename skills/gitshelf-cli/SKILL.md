---
name: gitshelf-cli
description: Use when the user wants to deploy or manage content on a GitShelf site — a zero-cost GitHub Pages platform that turns PDFs into chapter books, renders Markdown as documents, and hosts ZIP archives as static sites. Provides CLI commands for uploading, inspecting, editing, deleting, reconverting, and checking failures.
---

# GitShelf CLI

GitShelf deploys content to GitHub Pages at zero server cost. Upload a PDF and it becomes a multi-chapter book with TOC and reader UI; upload Markdown and it renders as a document; upload a ZIP and it hosts as a static site. Everything is processed by GitHub Actions and served from GitHub Pages.

Operate a GitShelf repository from the command line.

- Prefer running commands through `npx gitshelf` instead of invoking repository source files directly.

- Treat `.pdf` uploads as `book` items.
- Treat `.md` uploads as `doc` items.
- Treat `.zip` uploads as `site` items.
- Require `index.html` inside each uploaded site archive.

## Config

- Store only the default repo in `~/.config/gitshelf/config.json`.
- Store a local override in `.gitshelfrc` inside the current working directory when needed.
- Supply the fine-grained token through `GITSHELF_TOKEN` or a system secret store. Do not
  put it in command arguments, shell history, or plaintext JSON files.
- Use this repo configuration:

```json
{
  "repo": "owner/repo"
}
```

- Resolve config in this order:
  CLI flags -> `GITSHELF_TOKEN` / `GITSHELF_REPO` -> `.gitshelfrc` -> `~/.config/gitshelf/config.json`

## Common commands

- Run `list` to discover item ids.
- Run `upload` to send new content.
- Run `info`, `edit`, `delete`, and `reconvert` against existing items.
- Run `failures` to inspect or retry processing errors.

```bash
npx gitshelf list
npx gitshelf list --type site --json
npx gitshelf info book:my-book
npx gitshelf upload ./article.md
npx gitshelf upload ./book.pdf
npx gitshelf upload ./site.zip
npx gitshelf edit doc:my-article --title "New title"
npx gitshelf delete site:my-site --yes
npx gitshelf reconvert book:my-book
npx gitshelf failures --json
```

## npx usage

- Default to `npx gitshelf ...` for CLI usage.
- Add `NPM_CONFIG_CACHE=/tmp/gitshelf-npm-cache` only if `npx` fails because its default cache path is not writable.

```bash
npx gitshelf list
npx gitshelf upload ./site.zip
NPM_CONFIG_CACHE=/tmp/gitshelf-npm-cache npx gitshelf upload ./site.zip
```

## Item selectors

- Pass either `id` or `type:id` to commands that target existing content.
- Prefer `type:id` when ids may collide.
- Use only `book`, `doc`, and `site` as item types.

## Practical defaults

- Add `--json` when the user wants machine-readable output.
- Check `failures` after `upload` when processing does not complete.
- Restrict `reconvert` to `book` items.
- Add `--yes` to `delete` in non-interactive agent runs.
