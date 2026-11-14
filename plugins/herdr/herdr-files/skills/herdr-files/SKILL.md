---
name: herdr-files
description: Install, update, check or remove herdr-files, a Files panel for the Herdr app that can go to parent and other folders and edit local Markdown and text files with an explicit Save. Use when the person asks to set up, update, check, troubleshoot or uninstall herdr-files, or wants Herdr's Files panel to browse other folders or edit Markdown.
---

# herdr-files

The plugin root is `<directory containing this SKILL.md>/../..`. It holds `install.mjs`, `uninstall.mjs`, `status.mjs` and the mod they install. Run them with Node.js 22 or newer from any folder; below, `<root>` is the plugin root's absolute path. macOS and Linux are supported.

Nothing installs on its own: run the installer when the person asks to install or update herdr-files. That request is the approval. In one short message, say what it changes (below), then run it. Ask only when something outside that scope is needed, such as choosing a layout or resolving a name collision.

## What the installer changes

- Copies the mod to `<Herdr home>/mods/herdr-files`. The Herdr home is `$HERDR_APP_HOME`, or `~/.config/herdr-app`.
- In one personal layout, changes only the block with id `files` from Herdr's `files` mod to `herdr-files`. The block id stays, so the tab bar's Files button keeps working. A backup of the layout goes to `<Herdr home>/herdr-files/backups/`, and what was changed is recorded in `<Herdr home>/herdr-files/install.json`.
- Herdr's own layouts (`main`, `terminals`, `win98`) are replaced on every start, so they are never edited.
- It never switches layouts and never changes focus, spaces, tabs or panes. Herdr reloads an edited layout file in place.

## Install or update

```sh
node <root>/install.mjs                                    # the selected layout, if it is a personal one
node <root>/install.mjs --layout <name>                    # that personal layout
node <root>/install.mjs --create-layout <name> --from main # a new personal copy of main; not shown
node <root>/install.mjs --no-layout                        # the mod only
```

- With no option, if the selected layout is one of Herdr's own, only the mod is installed and the output says how to go on. Offer `--create-layout`.
- A created layout is not shown. Show it only if the person asks: `herdr-app do layout.switch '{"name":"<name>"}'`.
- The same command updates in place. It keeps the recorded original and makes no new backup when nothing changes.

Every check runs before the layout, the mod folder or the state is written, and a failed check changes nothing. If applying fails partway, the installer puts everything back. On a nonzero exit, show the message: it says what to fix and whether anything changed. Do not delete or rename the person's files to get past a check. A mod named `herdr-files` that this package did not install, or a `files` block that shows another mod, is the person's to resolve.

## Check

```sh
node <root>/status.mjs          # add --json for machine-readable output
```

It reports whether the mod is installed, the selected layout, each layout that shows herdr-files, and any Herdr errors for the mod. It exits 1 when the mod is not installed. It only reads; `herdr-app status` does not change the window. For a mod error, run `herdr-app check <Herdr home>/mods/herdr-files`.

## Uninstall

```sh
node <root>/uninstall.mjs
```

- In each recorded layout, the `files` block goes back to the mod it showed before, but only while it still shows `herdr-files`.
- A layout the installer created is deleted only if it is unchanged and not the selected layout. Otherwise it is kept, with its block restored.
- The mod and `<Herdr home>/herdr-files` are removed only when no layout still shows the mod and every layout file can be read.
- A nonzero exit means something was left in place on purpose; relay the message.

## Using the panel

- **Folders:** `↑` goes to the parent folder. `Open…` picks a folder with the system dialog (local only). `Path` takes a typed or pasted path (spaces, quotes, `~` and relative paths work). `Project` goes back to following the focused pane's folder. The chosen folder is kept per space.
- **Editing:** only local `.md`, `.markdown`, `.mdx`, `.txt` and `.text` files, and files with no extension, can be edited. Remote files, truncated files (over 400,000 characters or near the 1 MiB read limit) and other types open read-only with a label; binary files show no text.
- **Saving:** nothing is written until Save or Cmd-S/Ctrl-S. If the file changed or was deleted on disk since it was opened, Save writes nothing and offers reload, overwrite, recreate or copy.
- **Unsaved changes:** closing or switching files asks to Save, Discard or Cancel. Unsaved text is lost if the panel itself is restarted (a layout switch, quitting Herdr, or an update of the mod).
- **Self-test:** while the panel is shown, `herdr-app do herdr-files.selftest` runs a self-test with the real file APIs in a new `/tmp/herdr-files-selftest.XXXXXX` folder and posts the result as a notification.
