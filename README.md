# Window Tray

A GNOME Shell extension that turns *minimize* into a real system tray for the
apps you choose — instead of a workspace.

**GNOME Shell 50+ · Wayland · X11 · MIT/GPL-2.0 (see [License](#license))**

<p align="left">
  <img src="docs/screenshot.png" alt="Window Tray panel menu with two minimized windows" width="420">
</p>

> Add a screenshot here (`docs/screenshot.png`) and, ideally, a ~10 s screen
> recording: minimize an app → it disappears from Alt+Tab and the overview →
> click its tray row on another workspace → it appears there.

## The problem with "one workspace per project"

The usual GNOME mental model is *one workspace per task or project*, and it
works well — until an app doesn't belong to any project. Messaging, mail,
calendar, a monitoring dashboard, a terminal you keep for emergencies. Those
apps are not *where you work*, they are *with you while you work*.

Two common answers both disappoint:

- **A permanent workspace for chat** means either switching away from your
  project to read a message, or a workspace you flip to and back constantly.
  It also breaks down as soon as you have more than a couple of these apps.
- **Leaving them on every workspace** means they reappear in the overview, in
  Alt+Tab, and in your window count forever.

Window Tray takes the third route, and it is the one every desktop OS had for
decades: **minimize to tray**. It is deliberately *not* workspace-based. You
pick applications; minimizing one of their windows puts a row in the panel
menu, and activating the app again brings that existing window to **whichever
workspace you are on right now**. Your workspace layout never changes, and no
"parking workspace" is created, renamed, or consumed.

If you want apps that follow you across workspaces, this is that extension. If
you want a dedicated tray workspace, this is explicitly not it.

## What it does

- Minimizing a configured app's window adds a row to the panel tray, with icon,
  title, and a per-window close button.
- While in the tray, the window is hidden from the overview, Alt+Tab, taskbars,
  and pagers — it stops being a window you have to mentally filter out.
- Clicking a tray row moves that exact window to the current workspace and
  focuses it.
- Activating a configured app from the dash, an app grid, a launcher, or its own
  notification moves its existing window to the current workspace instead of
  switching you to where you left it.
- This move-to-current-workspace behavior can be disabled in preferences to use
  GNOME's normal workspace switching instead.
- Works with external launchers (e.g. Vicinae) that ask a single-instance app to
  present its existing window.
- Explicit "new window" actions — middle-click, Ctrl+click, **New Window** —
  keep their normal meaning.
- Intentional workspace moves (keyboard `Shift+Ctrl+Alt+←/→`, drag and drop in
  the overview) are preserved; the tray never steals them.
- The window's own close button, `File → Quit`, and `Alt+F4` are untouched. The
  tray only reinterprets *minimize*, never *close*.
- Every minimized window gets its own row, so multi-window apps stay reachable
  individually.

Under the hood it combines genuine Mutter minimized state with temporary
window-list suppression, so nothing is faked and state is fully restored when an
app is removed from the configuration or the extension is disabled.

## Install

### From a release (recommended)

```sh
gnome-extensions install window-tray@buschjaeger.github.io.shell-extension.zip
```

Then log out and back in (a session restart is required for GNOME Shell to
discover a newly installed extension) and enable it:

```sh
gnome-extensions enable window-tray@buschjaeger.github.io
```

### From the working tree

```sh
./scripts/pack.sh --install
```

### Enable

Either from the **Extensions** app, or:

```sh
gnome-extensions enable window-tray@buschjaeger.github.io
gnome-extensions prefs window-tray@buschjaeger.github.io
```

## Configure

Open the preferences (Extensions app → Window Tray → ⚙, or the command above).

**Easiest path:** focus the app you want in the tray, open Window Tray's
preferences, hit **Use last focused application**. The extension records the last
app focused before the settings opened (it ignores the Extensions app itself) and
pre-fills it for you.

You can also add apps manually by **desktop-ID prefix**. Prefix matching is
intentional, and it has one sharp edge worth knowing:

> `firefox` also matches `firefox-browser`, because matching is a prefix test.
> For an exact match use the full desktop ID.

Config lives in `~/.config/window-tray/config.json` and is picked up live — no
restart needed after changing applications or workspace behavior.

## Known limitations

Please read this before filing "it doesn't work with X" — these are the real
boundaries of the current implementation.

- **GNOME Shell 50, 51 and 52** (`"shell-version": ["50", "51", "52"]`). Older shells are not
  supported.
- **Generic Chromium/Brave notifications.** Some PWAs notify under the generic
  browser desktop ID. In Preferences, you can add notification URL host hints to
  a PWA entry (for example, `chat.example.com`). Window Tray uses the first URL
  in the notification body and routes only when it matches exactly one configured PWA and that
  PWA has exactly one managed window. Otherwise Brave handles the notification
  without Window Tray moving a window. The URL is only a hint: if a notification
  includes a link to another site first, it may not identify the sender. Desktop-file
  app IDs and `StartupWMClass` identify PWA windows, but do not identify which
  PWA produced a generic notification.
- **Nothing is closed implicitly.** A tray row's × sends a normal close request;
  the app may still show its own dialogs or refuse.
- Windows that are already `skip-taskbar` (many docks, panels, notifications,
  override-redirect windows) are never trayed — by design.
- Minimize-to-tray state is per session; it is not restored across reboots.

## Troubleshooting

Follow the extension log while reproducing an issue:

```sh
journalctl --user -f _COMM=gnome-shell | grep --line-buffered "Window Tray"
```

or use `./scripts/watch-notifications.sh`, which additionally surfaces
notification-related lines.

Useful when reporting a bug: the app's desktop ID
(`ls /usr/share/applications | grep -i <name>`), its WM class
(`xprop WM_CLASS` on X11, or the log output on Wayland), and the log lines.

## Development

```
window-tray@buschjaeger.github.io/
  extension.js            # panel indicator + window/app/notification tracking
  prefs.js                # Adw preferences window
  config.js               # JSON config load/save/normalize (shared process boundary)
  metadata.json
  stylesheet.css
  window-tray-symbolic.svg
scripts/
  pack.sh                 # build (and optionally install) the extension zip
  watch-notifications.sh  # log helper
```

Build a zip:

```sh
./scripts/pack.sh
```

`config.js` and the SVG are not picked up by `gnome-extensions pack`'s default
heuristics, so they are passed with `--extra-source` — a packaging change that
forgets them produces an extension that crashes on enable, which is a confusing
bug to debug remotely.

## Contributing

Issues and pull requests are welcome — especially GNOME version backports,
packaging (Flathub/NixOS/AUR), and tests for the app-matching logic.
Please include the app's desktop ID and the log lines described above.

## Credits and rationale

This extension started as a weekend tool to fix a workflow I disliked, and I used
an AI assistant to get over the "I don't know the Shell extension API yet" hump.
Everything here has since been reviewed and is maintained by me; the parts that
are actually subtle are the app/WM-class matching, the four separate activation
hooks (dash click, launcher presentation, overview window activation, and the
move-to-workspace keybinding must stay distinguishable), and the notification
fallback for PWAs. Happy to talk through any of it — and PRs that improve it are
very welcome.

## License

GPL-2.0-only (see `LICENSE`), as is customary for GNOME Shell extensions that
link against GNOME Shell itself.

## Changelog

### 1.0

- Initial release: minimize-to-tray for configured apps, panel menu with
  per-window rows and close buttons, cross-workspace activation from dash,
  launchers, and notifications, PWA notification fallback, live config reload.
