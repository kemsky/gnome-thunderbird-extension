# Gnome shell extension for Thunderbird

A GNOME Shell extension that adds a Thunderbird system tray icon to the top panel.

Download extension from [Releases](https://github.com/kemsky/gnome-thunderbird-extension/releases/) page.

## Features

- **Tray icon** — always visible in the top panel; greyed out when Thunderbird is not running
- **Dock hiding** — automatically removes Thunderbird from the dock when all its windows are minimized
- **One-click restore** — click the tray icon to unminimize all windows and bring Thunderbird back to the dock
- **Unread badge** — a small orange dot appears on the tray icon when Thunderbird sends a desktop notification
- **Launch** — clicking the tray icon when Thunderbird is not running launches it
- **Wayland native** — no X11 tools required

## Preferences

Install `gnome-extensions-app` to manage extension preferences (https://apps.gnome.org/Extensions/):

```bash
sudo apt-get install gnome-extensions-app
```

## Requirements

- GNOME Shell 45–50
- Thunderbird (package, snap, or Flatpak)

## How it works

Extension patches `Shell.AppSystem.running_apps` and `Shell.App.get_windows` to hide app and its notifications from Dock. Also, it monitors notifications to detect when Thunderbird receives a new email.

If you know a better way to do this please let me know.

## Build and development

Requires NodeJS.

```bash
yarn install
```

```bash
yarn extension-install
yarn extension-enable
```

Log out and back in for the extension to fully load.

> **Note:** GNOME Shell caches JavaScript modules in memory. Code changes only take full effect after a session logout/login.

## License

MIT
