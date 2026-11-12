# Note Manager

A file manager for your vault: sort, search and reorganise notes, PDFs, images and canvas from one wide view.

Supported languages: English, 简体中文, 繁體中文, 日本語, 한국어, Deutsch, Français, Español

![Note Manager showing a vault with many folders](assets/screenshot-1.png)
![Note Manager showing a vault with Baseline Theme](assets/screenshot-2.png)
---

## What it does

Manager is, in a sense, a replacement for the file list. The built-in file explorer lives in a narrow sidebar, which makes real note management hard; Manager takes the main area, which makes tidying up far easier.

It sorts and groups notes using nothing but each file's path, name, modification time and creation time.

---

## Using it

### Top bar

1. Two icons: a clock with a rewind arrow for notes sorted by when they were last modified, and a stacked-layers shape for all files in the vault
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

## No build step

Manager ships as one file. There is no bundler, no `node_modules`, no compile pass, nothing to `npm install` before you can read the source: `main.js` is 2,472 lines and every one of them is the code that runs. Open it and read it.

The only outside name it reaches for is `obsidian`, which the app injects at load time. Everything else is plain JavaScript.

## Test

```
node test.cjs
```

`test.cjs` swaps `require("obsidian")` for a stub, loads `main.js` unchanged and exercises the pure functions exported on `__core`: path handling, name collisions, sort comparators, row building. No framework, no fixtures, one file.

---
## Version

1.0.2

- Renamed to Note Manager, with a description that says what it actually does
- README no longer lists build and test commands that do not exist in the plugin folder
- Fixed: Recent sorts by modification time, not by when a note was last opened
- Added screenshots and a `test.cjs` you can run on its own

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
