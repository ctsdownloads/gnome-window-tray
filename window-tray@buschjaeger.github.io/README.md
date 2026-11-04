# Window Tray

GNOME Shell extension: **minimize-to-tray for the apps you choose**, instead of
a workspace.

**GNOME Shell 50+ · Wayland · X11 · GPL-2.0-only**

## Why not workspaces?

The GNOME mental model is one workspace per project. That works — until an app
belongs to no project: messaging, mail, calendar, monitoring. Those apps are not
*where you work*, they are *with you while you work*.

Giving them a permanent tray workspace means switching away from your project to
read a message, and it stops scaling after two or three apps. Leaving them
everywhere means they haunt the overview, Alt+Tab, and your window count.

Window Tray does what desktop OSes did for decades instead: minimize puts the
window in a **panel tray**, and activating the app brings that existing window to
**whichever workspace you are on**. Your workspace layout never changes and no
parking workspace is created.

## Behavior

- Minimizing a configured app's window adds a row (icon, title, close button) to
  the panel tray.
- Tray windows are hidden from the overview, Alt+Tab, taskbars, and pagers.
- Clicking a row moves that exact window to the current workspace and focuses it.
- Activating a configured app from the dash, app grid, a launcher (e.g.
  Vicinae), or its notification brings its existing window to the current
  workspace instead of switching you to it.
- This move-to-current-workspace behavior can be disabled in preferences to use
  GNOME's normal workspace switching instead.
- **New window**, middle-click, and Ctrl+click keep their normal meaning.
- Intentional workspace moves (`Shift+Ctrl+Alt+←/→`, overview drag-and-drop) are
  never intercepted.
- The window close button, `File → Quit`, and `Alt+F4` are untouched: this
  extension reinterprets *minimize*, never *close*.
- Every minimized window gets its own row, so multi-window apps stay individually
  reachable.

Uses genuine Mutter minimized state plus temporary window-list suppression —
nothing is faked, and visibility is fully restored when an app is unconfigured or
the extension is disabled.

## Install

```sh
gnome-extensions install window-tray@buschjaeger.github.io.shell-extension.zip
```

Log out and back in (GNOME Shell only discovers new extensions at session start),
then:

```sh
gnome-extensions enable window-tray@buschjaeger.github.io
```

From the working tree: `./scripts/pack.sh --install`.

## Configure

```sh
gnome-extensions prefs window-tray@buschjaeger.github.io
```

Simplest: choose **Choose from installed applications**, search, and click the
app. Works for Flatpaks and Brave/Chrome web apps too.

Or: focus the app you want trayed, open Window Tray's preferences, choose
**Use last focused application**. Or add apps by desktop-ID prefix.

> Prefix matching means `firefox` also matches `firefox-browser`. Use the full
> desktop ID for an exact match.

Config lives in `~/.config/window-tray/config.json` and reloads live — no restart
after editing the app list or workspace behavior.

## Known limitations

- **GNOME Shell 50, 51 and 52.**
- **Generic Chromium/Brave notifications.** Some PWAs publish notifications
  under the generic browser desktop ID. Add notification URL host hints to a
  PWA entry in Preferences (for example, `chat.example.com`). Window Tray uses
  the first URL in the notification body and routes only if it matches exactly one configured PWA
  and that PWA has exactly one managed window. Otherwise Brave handles the
  notification without Window Tray moving a window. A URL in the notification
  is only a hint and may link to a different site first; the browser's desktop-file
  app ID and `StartupWMClass` identify PWA windows, not notification origins.
- A tray row's × sends a normal close *request*; apps may still veto.
- `skip-taskbar` windows (docks, panels, many notification windows) are never
  trayed.
- Tray membership is per session and not restored across reboots.

## Development

```
window-tray@buschjaeger.github.io/   extension.js · prefs.js · config.js · metadata.json · stylesheet.css · *.svg
scripts/pack.sh                      build (+ --install) the extension zip
scripts/watch-notifications.sh       log helper for notification issues
```

`config.js` and the SVG need explicit `--extra-source` flags for
`gnome-extensions pack`; `scripts/pack.sh` encodes that, because a zip missing
them fails on enable.

```sh
./scripts/pack.sh            # -> dist/window-tray@buschjaeger.github.io.shell-extension.zip
journalctl --user -f _COMM=gnome-shell | grep --line-buffered "Window Tray"
```

When reporting a bug, include the app's desktop ID
(`ls /usr/share/applications | grep -i <name>`) and the matching log lines.

## Contributing

Issues and PRs welcome — especially version backports, packaging (Flathub, NixOS,
AUR), and tests for the app-matching logic.

## Origin

Built in a weekend to fix a workflow I disliked, with an AI assistant helping me
get past the Shell extension API learning curve. Everything is reviewed and
maintained by me. The genuinely subtle parts are app/WM-class matching, keeping
four activation paths distinguishable (dash click, external launcher
presentation, overview window activation, move-to-workspace keybinding), and the
PWA notification fallback.

## License

GPL-2.0-only, as is customary for extensions linking against GNOME Shell.
