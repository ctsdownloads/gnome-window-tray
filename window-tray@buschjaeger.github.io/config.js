// Configuration storage for Window Tray.
//
// Format: ~/.config/window-tray/config.json
//
//   {
//     "trayApps": [
//       {"name": "Mattermost", "desktopIdPrefixes": ["Mattermost"],
//        "notificationDomains": ["chat.example.com"]}
//     ],
//     "moveToCurrentWorkspace": true,
//     "lastFocusedApp": {"appId": "firefox.desktop", "title": "Firefox"}
//   }
//
// Why a JSON file and not GSettings: tray apps are a list of objects with
// variable-length nested string arrays, which GSettings can only express as an
// opaque `a{sas}` blob — unusable in a hand-written prefs UI, unreadable in dconf
// dumps, and awkward to script. A file is diffable, lives in dotfiles, and can be
// inspected or edited by hand or from a script, which is the whole point of this
// extension.
//
// Consequences of the file choice, both handled here:
//   * Extension and preferences run in separate processes, so every read
//     re-parses the file and every write is a full replace. `saveConfig` merges
//     nothing: callers pass the complete config.
//   * `_rememberFocusedApp` therefore re-reads before writing, so focus capture
//     can never clobber a concurrent tray-app edit.
//   * `watchConfig` uses a file monitor; the callback re-reads, so a write from
//     this process that produces identical content is a cheap no-op.
//
// Normalization happens in exactly one place: `normalize()`, applied on both load
// and save. Nothing else in the extension may repair or reinterpret config data.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {debug, error, warn} from './logging.js';

// Deliberately 'window-tray' rather than derived from the extension UUID, so
// existing 1.0-alpha users keep their configuration across the upgrade.
const CONFIG_DIRECTORY = 'window-tray';
const CONFIG_FILE_NAME = 'config.json';

export const DEFAULT_CONFIG = Object.freeze({
    trayApps: [],
    moveToCurrentWorkspace: true,
    lastFocusedApp: null,
});

/** Whether two normalized tray-app lists describe the same configuration. */
export function trayAppsEqual(left, right) {
    if (left === right)
        return true;
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
        return false;

    return left.every((app, index) => {
        const other = right[index];
        const prefixes = app?.desktopIdPrefixes;
        const otherPrefixes = other?.desktopIdPrefixes;
        return app?.name === other?.name &&
            Array.isArray(prefixes) && Array.isArray(otherPrefixes) &&
            prefixes.length === otherPrefixes.length &&
            prefixes.every((prefix, prefixIndex) => prefix === otherPrefixes[prefixIndex]);
    });
}

export function getConfigFile() {
    return Gio.File.new_for_path(GLib.build_filenamev([
        GLib.get_user_config_dir(), CONFIG_DIRECTORY, CONFIG_FILE_NAME,
    ]));
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

/** The single normalization point. Guarantees shape; never throws. */
function normalize(raw) {
    const config = {
        trayApps: [],
        moveToCurrentWorkspace: true,
        lastFocusedApp: null,
    };
    if (!raw || typeof raw !== 'object')
        return config;

    if (Array.isArray(raw.trayApps)) {
        config.trayApps = raw.trayApps
            .filter(app => app && typeof app === 'object')
            .map(app => ({
                name: String(app.name ?? '') || 'Unnamed application',
                desktopIdPrefixes: Array.isArray(app.desktopIdPrefixes)
                    ? [...new Set(app.desktopIdPrefixes
                        .map(value => String(value).trim()).filter(Boolean))]
                    : [],
                notificationDomains: Array.isArray(app.notificationDomains)
                    ? [...new Set(app.notificationDomains
                        .map(value => String(value).trim().toLowerCase()
                            .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0])
                        .filter(Boolean))]
                    : [],
            }))
            // An app with no prefixes could never match anything.
            .filter(app => app.desktopIdPrefixes.length > 0);
    }

    if (typeof raw.moveToCurrentWorkspace === 'boolean')
        config.moveToCurrentWorkspace = raw.moveToCurrentWorkspace;

    if (raw.lastFocusedApp && typeof raw.lastFocusedApp === 'object') {
        const appId = String(raw.lastFocusedApp.appId ?? '');
        if (appId) {
            config.lastFocusedApp = {
                appId,
                title: String(raw.lastFocusedApp.title ?? ''),
            };
        }
    }
    return config;
}

export function loadConfig() {
    const file = getConfigFile();
    let bytes;
    try {
        bytes = file.load_contents(null)[1];
    } catch (e) {
        // Absent config is the normal first-run case.
        if (e.code !== Gio.IOErrorEnum.NOT_FOUND)
            warn(`unable to read configuration: ${e.message}`);
        return clone(DEFAULT_CONFIG);
    }

    try {
        const config = normalize(JSON.parse(new TextDecoder().decode(bytes)));
        debug('config', `loaded ${config.trayApps.length} tray app(s)`);
        return config;
    } catch (e) {
        error(`configuration is not valid JSON, using defaults: ${e.message}`);
        return clone(DEFAULT_CONFIG);
    }
}

export function saveConfig(config) {
    const file = getConfigFile();
    try {
        const directory = file.get_parent();
        if (!directory.query_exists(null))
            directory.make_directory_with_parents(null);
        file.replace_contents(
            JSON.stringify(normalize(config), null, 2), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        debug('config', 'configuration written');
        return true;
    } catch (e) {
        error(`unable to write configuration: ${e.message}`);
        return false;
    }
}

/**
 * Watches the config file and invokes `onChange(loadConfig())` on change.
 * Returns a function that stops watching. Debounced, because a single
 * `replace_contents` can emit several monitor events.
 */
export function watchConfig(onChange) {
    const file = getConfigFile();
    let monitor;
    try {
        monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
    } catch (e) {
        warn(`unable to watch configuration: ${e.message}`);
        return () => {};
    }

    let timerId = 0;
    monitor.connect('changed', () => {
        if (timerId)
            GLib.Source.remove(timerId);
        timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            timerId = 0;
            onChange(loadConfig());
            return GLib.SOURCE_REMOVE;
        });
    });

    return () => {
        if (timerId)
            GLib.Source.remove(timerId);
        monitor.cancel();
    };
}
