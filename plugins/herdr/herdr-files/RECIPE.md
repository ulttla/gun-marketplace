# Recipe: herdr-files

The brief this build follows, for rebuilding it from scratch or adapting it to another Herdr version.

## Goal

Herdr's Files panel shows only the focused pane's folder and previews files read-only. herdr-files keeps that panel and adds two things: browsing other folders, and editing local Markdown/text files. Edits must never be lost silently or overwrite a newer file.

## Pieces

1. **Mod** (`mod/herdr-files`). It starts from Herdr's shipped `files` mod, cloned and modified; the shipped mod stays untouched.
   - **Tree view.** The header has `↑` (parent), `Open…` (`pickFolder`, local only), `Path` (an `InputState`; the path is resolved and checked with `test -d` before switching) and `Project` (clears the manual root). Below the header is a line with the full root path. The manual root is kept per space id, as `{cwd, on}`, in the mod's `localStorage`.
     - The panel's context key includes the manual root, so terminal `cd`s don't move it.
     - There is no `watchFolder` on `/` or on the home folder.
     - `joinPath` handles the `/` root.
   - **Document view.**
     - Header: `←`, the file name, `●`, a status line (`Modified`, `Saved`, `Saving…` or a read-only label), and the Revert and Save buttons.
     - A full-path line.
     - Banners: unsaved changes (Save/Discard/Cancel), changed on disk (discard and reload, overwrite, copy mine), deleted (recreate, copy mine), save error.
     - The `Editor`, wrapped in a `v_flex` whose `on_key_down` handles `cmd-s` and `ctrl-s`.
   - **`core.js`** (pure, Node-testable):
     - Paths: `joinPath`, `parentDir`, `resolveInput`.
     - `classify`: editable only when the file is local, the text is whole (at most 400,000 chars and under 1 MiB of UTF-8), and the extension is md/markdown/mdx/txt/text or there is none.
     - `DocController`:
       - a sequence token on every open and close; stale reads create no editor
       - dirty = `value() !== saved`, with a redraw only when it flips
       - `save()`: guarded by `saving`, then `writeTextFile(path, text, expected = saved)`. On rejection it re-reads the file to tell "changed" from "deleted". After every await it checks the document is still open.
       - overwrite against the disk snapshot it just read; recreate with `expected = null`
       - `request()` and `resolve()` for navigation, refused while a save is writing
     - `rememberedFile()` and `keepsDoc()`: a held document stays open across context switches, and is never remembered by a context it was not opened in.
   - **`selftest.js`**: the `herdr-files.selftest` command. It drives a separate `DocController` with the real APIs in a fresh `mktemp -d /tmp/herdr-files-selftest.XXXXXX` and reports with `notify` and a `result.json`.
2. **Installer**:
   - **Checks first:** platform, Node.js, Herdr home, `herdr-app`, mod and state ownership, the target layout, and `herdr-app check` of the staged mod.
   - **Target layout:** `--layout`, or else the selected one from `shared.json`. Herdr's own layouts (`installed.json` keys `layout:<name>`) are refused; `--create-layout` writes a new personal copy instead.
   - **The one edit:** only blocks with `id: "files"` showing `files` get `content.mod` set to `herdr-files`. Any other mod in that block stops the install.
   - **Writes:** a backup before the first change; atomic writes; an undo list that restores the previous mod, layout, backup and state if any later write fails.
   - **The window:** only `herdr-app check` and `herdr-app status` are called. There is never a `layout.switch` or any `do` command.
   - **Uninstall:**
     - The block goes back to the recorded previous mod, only while it still shows `herdr-files`.
     - A created layout is deleted only when its hash still matches and it is not selected.
     - The mod and the state folder go only when every layout parses and none references the mod.
     - A foreign state folder is refused.

## Herdr APIs used

`spaces`, `panes`, `focused`, `exec`, `readTextFile`, `writeTextFile`, `watchFolder`, `pickFolder`, `home`, `theme`, `settings`, `window`, `nextCommand`, `notify`, `localStorage`; gpui-kit `View`, `div`, `svg`, `h_flex`, `v_flex`, `Editor`, `EditorState`, `InputState`, `Input`, `Context.write_to_clipboard`. Commands: `herdr-app check`, `herdr-app status`.

## Watch out

- `herdr-app check` renders only the first frame and runs no later async work. To check the document view, render a copy whose `init` sets a document synchronously. Async behavior is covered by the Node tests and the self-test.
- `EditorState` has no way to switch readonly later; make a new one. Create it in an event handler or after an await, never in `render`.
- `<mod>.<command>` reaches only copies that are shown, so the self-test needs the panel visible.
- Keep `id: "files"` on the block: Herdr's tab bar toggles the panel by that id.
- Unsaved text lives only in the panel instance; a layout switch or quit loses it.

## Done when

- `node --test test/*.test.mjs` passes, `node test/catalog-check.mjs` passes, and `herdr-app check` passes on the installed mod.
- With the panel shown, `herdr-app do herdr-files.selftest` reports every case passed.
