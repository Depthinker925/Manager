# Manager

Effortless Note Management

Supported languages: English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español

v 1.0.0

---

## What it does

Manager is, in a sense, a replacement for the file list. The built-in file explorer lives in a narrow sidebar, which makes real note management hard; Manager takes the main area, which makes tidying up far easier.

It sorts and groups notes using nothing but each file's path, name, modification time and creation time.

---

## Using it

### Top bar

1. Two icons: a clock with a rewind arrow for notes sorted by when you last opened them, and a stacked-layers shape for all notes
2. Location: the root folder plus the names of first-level folders
3. Four fixed icons on the right: search, plus, pencil, sort

- Text is grey by default and brightens when selected
- Root appears only when the vault root actually holds files

### Search

- Click the search icon and a bordered input slides out from its left edge, covering the whole location strip

Right-click the search icon to switch scope:

- Note titles
- All text

Esc clears and closes it.

### Plus

Click it and you get New note and New folder.

Pick one and the plus turns into a checkmark: you are now in create mode. Click a folder name in the top bar, or any folder heading in the list, to choose where the file goes.

Click the checkmark to commit.

- New note: named `Untitled`, opens in the current tab once created
- New folder: named `Untitled folder`, goes straight into rename afterwards

### Pencil

Click to enter reorder mode.

Folder names in the top bar can be dragged; this only changes display order and is saved to plugin settings. Folder headings and files in the list can be moved as well.

### Sort

- Name, A to Z
- Name, Z to A
- Modified, newest first
- Modified, oldest first
- Created, newest first
- Created, oldest first

### Below the divider

Folders are headings, files sit under them.

Type size steps down by level:

- First-level folder 18
- Second level 16
- Third level and deeper 13, in grey

Click a folder heading to collapse its contents.

### Motion

- Switching tabs, changing sort, collapsing and expanding: the list fades in as a whole
- Menus fade in as they appear
- The plus and pencil bounce when they turn into checkmarks

All of it can be turned off in settings.

---

## Supported file types

- Notes `.md`
- PDF `.pdf`
- Images `.png` `.jpg` `.jpeg` `.gif` `.webp` `.svg` `.bmp`
- Audio `.mp3` `.wav` `.m4a` `.ogg` `.flac` `.3gp`
- Video `.mp4` `.webm` `.ogv` `.mov` `.mkv`
- Canvas `.canvas`

---

## Where data lives

- `tabOrder`: top bar order, an array of paths
- `noteOrder`: manual file order per directory
- `folderOrder`: manual folder order per directory
- `collapsed`: folders that are collapsed
- `sortMode`: current sort
- `searchScope`: search scope, `title` or `full`
- `listLimit`: rows rendered per pass, 120 by default
- `blockedFolders`: block list, newline-separated string
- `showAll` `showRecent`: toggles for the two top-bar views
- `showEmptyFolders`: whether empty folders show
- `showSettingsIcon`: toggle for the ribbon gear
- `homePage`: whether Manager opens on startup
- `collapseSidebar`: whether the left sidebar collapses on open
- `animations`: interface animation toggle

---

## Source layout

- `00-prelude.js`: path helpers, name collisions, sort comparators
- `05-i18n.js`: text tables for the eight languages
- `10-index.js`: scans the vault, builds row data
- `20-view.js`: view shell, top bar, list rendering
- `30-interact.js`: clicks, creation, drag, collapse, context menu
- `40-search.js`: full-text search in batches
- `45-settings.js`: settings page
- `50-plugin.js`: plugin entry, startup curtain, ribbon and command

---

## Build and test

```
node build.cjs          bundle main.js
node test/core.cjs      pure functions, plugin registration, i18n coverage - 140 checks
node test/view.cjs      DOM and interaction - 84 checks, needs jsdom
node test/style.cjs     style rules - 75 checks
node test/preview.cjs   preview page self-check - 8 checks, runs the real main.js
node test/bench.cjs     timing at ten thousand files
```

---

## Version

1.0.1

- Manifest description now ends with a full stop
- The top bar fade no longer depends on CSS masks, which older builds only partly support
- Removed a duplicated overflow declaration on the status line
- Removed every `!important`; the animation switch now zeroes the duration variables instead

1.0.0

- Top bar: Recent and All as icons, locations as text, two groups, horizontally scrollable
- List: folder headings and files, stepped type size, collapsible
- File types: notes, PDF, images, audio, video, canvas
- Search: title and full-text scopes, switched by right-click
- Create: plus opens two choices, pick a target then commit
- Sort: six orders, icon follows direction
- Drag: top bar changes order only, the list really moves files
- Context menu: the same one the file explorer uses
- Settings: block list, empty folders, the two top-bar views, settings icon, home page, animation, sidebar
- Languages: eight
- Motion: list fade, menu pop, icon bounce
