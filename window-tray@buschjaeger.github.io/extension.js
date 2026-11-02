// Window Tray — GNOME Shell 50 extension.
//
// One narrow rule: when a normal window of a configured application becomes
// minimized, it appears in a panel tray and disappears from the overview,
// Alt+Tab, and taskbars. Activating that application then moves its existing
// window to the current workspace and focuses it. Close buttons, File → Quit,
// and Alt+F4 keep their normal meaning.
//
// Design notes for maintainers and reviewers:
//
//   * All matching logic is in matching.js (pure, unit-tested).
//   * All logging is in logging.js (off unless ~/.config/window-tray/debug exists).
//   * Interaction with Shell internals uses three mechanisms, in order of
//     preference:
//       1. Signals on global.display / Main.messageTray / Meta.Window — the
//          supported path, fully disconnected on disable.
//       2. PanelMenu.Button via Main.panel.addToStatusArea — the supported
//          extension point for panel UI.
//       3. Patching Shell.App.prototype activation methods and
//          Meta.Workspace.activate_with_focus — required because Shell offers
//          no signal for application/window activation. These are installed
//          through patchRegistry.js, which refuses to stack, restores by
//          identity, and unwinds in reverse order.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {loadConfig, saveConfig, trayAppsEqual, watchConfig} from './config.js';
import * as matching from './matching.js';
import * as patchRegistry from './patchRegistry.js';
import {debug, error} from './logging.js';

// A newly created window may not have its final WM_CLASS or app association yet,
// so it is re-examined once on idle and once after a short delay.
const WINDOW_RECHECK_DELAY_MS = 500;
// Deferred window-list restore after disable: Shell rebuilds overview UI across
// several main-loop turns, so cleanup must not run inside that transaction.
const DEFERRED_CLEANUP_DELAY_MS = 250;
// Native notification actions are resolved by the application. Remember where
// the action was invoked long enough to move the window the app actually
// presents, rather than guessing a window from the notification source.
const NOTIFICATION_ACTIVATION_TIMEOUT_MS = 3000;

// Workspace.activate_with_focus() is the one activation path that retains the
// exact Meta.Window for Chromium PWAs.  Do not intercept the same call when it
// came from Mutter's explicit move-to-workspace keybindings.
const MOVE_TO_WORKSPACE_ACTIONS = new Set([
    ...Array.from({length: 12}, (_, index) =>
        Meta.KeyBindingAction[`MOVE_TO_WORKSPACE_${index + 1}`]),
    Meta.KeyBindingAction.MOVE_TO_WORKSPACE_LAST,
    Meta.KeyBindingAction.MOVE_TO_WORKSPACE_LEFT,
    Meta.KeyBindingAction.MOVE_TO_WORKSPACE_RIGHT,
    Meta.KeyBindingAction.MOVE_TO_WORKSPACE_UP,
    Meta.KeyBindingAction.MOVE_TO_WORKSPACE_DOWN,
].filter(value => value !== undefined));

const PANEL_ICON = new Gio.FileIcon({
    file: Gio.File.new_for_uri(import.meta.url).get_parent()
        .resolve_relative_path('window-tray-symbolic.svg'),
});

/** Keys under which a config should be indexed in the WM_CLASS index. */
function wmClassKeysFor(config, appSystem) {
    const keys = [];
    for (const configuredId of config.desktopIdPrefixes) {
        const id = matching.normalizeId(configuredId);
        const app = appSystem.lookup_app(`${id}.desktop`) ?? appSystem.lookup_app(id);
        const startupClass = app?.get_app_info?.()?.get_string?.('StartupWMClass');
        if (startupClass)
            keys.push(startupClass);

        // Chromium/Edge PWA windows report `crx_<32-char-id>` as WM_CLASS.
        const chromiumId = matching.extractChromiumAppId(id);
        if (chromiumId)
            keys.push(`crx_${chromiumId}`);
    }
    return keys;
}

const WindowTrayIndicator = GObject.registerClass(
class WindowTrayIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Window Tray');
        this._extension = extension;
        this._rows = new Map();

        const box = new St.BoxLayout({style_class: 'panel-status-indicators-box'});
        box.add_child(new St.Icon({
            gicon: PANEL_ICON,
            icon_size: 16,
            style_class: 'system-status-icon',
        }));
        this._count = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'window-tray-count',
        });
        box.add_child(this._count);
        this.add_child(box);

        this._emptyItem = new PopupMenu.PopupMenuItem('No minimized tray windows', {
            reactive: false,
            can_focus: false,
        });
        this._emptyItem.label.add_style_class_name('window-tray-empty-label');
        this.menu.addMenuItem(this._emptyItem);
        this._syncCount();
    }

    addWindow(window, app) {
        if (this._rows.has(window)) {
            this.updateWindow(window);
            return;
        }

        const row = new PopupMenu.PopupBaseMenuItem();
        const icon = this._createIcon(app);
        row.add_child(icon);

        const label = new St.Label({
            text: this._windowTitle(window, app),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        row.add_child(label);
        row.label_actor = label;

        const closeButton = new St.Button({
            style_class: 'window-tray-close-button',
            can_focus: true,
            track_hover: true,
            accessible_name: `Close ${label.text}`,
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 16}),
        });
        closeButton.connect('clicked', () => this._extension.closeWindow(window));
        row.add_child(closeButton);
        row.connect('activate', () => this._extension.restoreWindow(window, 'tray menu'));

        this._rows.set(window, {row, icon, label, closeButton, app});
        this.menu.addMenuItem(row);
        this._syncCount();
    }

    updateWindow(window) {
        const entry = this._rows.get(window);
        if (!entry)
            return;
        // Re-render the app icon whenever the title changes: for Chromium PWAs the
        // generic browser app and the real PWA app resolve to different icons at
        // different times, so the icon is not stable at tray-insert time.
        const title = this._windowTitle(window, entry.app);
        const icon = this._createIcon(entry.app);
        entry.row.replace_child(entry.icon, icon);
        entry.icon = icon;
        entry.label.text = title;
        entry.closeButton.accessible_name = `Close ${title}`;
    }

    removeWindow(window) {
        const entry = this._rows.get(window);
        if (!entry)
            return;
        this._rows.delete(window);
        entry.row.destroy();
        this._syncCount();
    }

    _createIcon(app) {
        let icon;
        try {
            icon = app?.create_icon_texture?.(20);
        } catch (_) {
            icon = null;
        }
        icon ??= new St.Icon({
            icon_name: 'application-x-executable-symbolic',
            icon_size: 20,
        });
        icon.add_style_class_name('window-tray-row-icon');
        return icon;
    }

    _windowTitle(window, app) {
        return window.get_title?.() || app?.get_name?.() || 'Untitled window';
    }

    _syncCount() {
        const count = this._rows.size;
        this._count.text = count > 0 ? String(count) : '';
        this._emptyItem.visible = count === 0;
    }
});

export default class WindowTrayExtension {
    enable() {
        this._enabled = true;
        this._config = loadConfig();
        this._windowRecords = new Map();
        this._wmClassIndex = new Map();
        this._windowTimers = new Set();
        this._cleanupTimers = new Set();
        this._notificationHooks = new Map();
        this._notificationSourceSignals = new Map();
        this._pendingNotificationActivation = null;
        this._pendingNotificationActivationTimer = 0;
        this._signals = [];

        debug('lifecycle', `enabled state: ${this._config.trayApps.length} tray app(s) `
            + `${JSON.stringify(this._config.trayApps.map(app => app.name))}`);

        this._indicator = new WindowTrayIndicator(this);
        Main.panel.addToStatusArea('window-tray', this._indicator);

        this._rebuildWmClassIndex();
        this._configUnwatch = watchConfig(config => this._onConfigChanged(config));

        this._connect(global.display, 'window-created',
            (_display, window) => this._scheduleWindowChecks(window));
        this._connect(global.display, 'notify::focus-window',
            () => this._onFocusWindowChanged());

        this._scanWindows();
        this._rememberFocusedApp();
        this._installAppActivationHooks();
        this._installWindowActivationHook();
        this._messageTraySignal = Main.messageTray.connect(
            'source-added', (_tray, source) => this._watchNotificationSource(source));
        this._scanNotificationSources();
        debug('lifecycle', 'enabled');
    }

    disable() {
        this._enabled = false;

        if (this._messageTraySignal)
            Main.messageTray.disconnect(this._messageTraySignal);
        this._messageTraySignal = 0;

        // Restore notification wrappers individually rather than relying on
        // unpatchAll(): each handle also owns a 'destroy' signal on an object that
        // may be destroyed at any moment, so both must be released together.
        for (const [notification, handle] of this._notificationHooks) {
            handle.restore();
            try {
                notification.disconnect(handle.destroySignal);
            } catch (_) {
                // The notification may already be destroyed.
            }
        }
        this._notificationHooks.clear();

        for (const [source, signalIds] of this._notificationSourceSignals) {
            for (const signalId of signalIds) {
                try {
                    source.disconnect(signalId);
                } catch (_) {
                    // The source may already be destroyed.
                }
            }
        }
        this._notificationSourceSignals.clear();

        patchRegistry.unpatchAll();

        for (const [emitter, signalId] of this._signals)
            emitter.disconnect(signalId);
        this._signals = [];

        // Cancel cleanup left over from the active instance before scheduling
        // the final window-list restores below.  Those final restores must be
        // allowed to run after disable(): lock/suspend disables user extensions,
        // and cancelling them leaves the windows skip-taskbar.  On resume the
        // new instance then considers those windows ineligible, losing the tray
        // rows and all subsequent minimize handling for them.
        this._cancelAll(this._cleanupTimers);
        for (const window of [...this._windowRecords.keys()])
            this._untrackWindow(window, {deferWindowListRestore: true});

        this._cancelAll(this._windowTimers);
        this._configUnwatch?.();
        this._configUnwatch = null;
        this._cancel(this, '_pendingNotificationActivationTimer');
        this._pendingNotificationActivation = null;

        this._indicator?.destroy();
        this._indicator = null;
        debug('lifecycle', 'disabled');
    }

    // Timers
    //
    // Every source id is registered in a set so disable() can cancel anything that
    // has not fired yet. A source that removes itself is removed from the set on
    // disable as well; removing an already-removed id is harmless because
    // GLib.Source.remove() on a stale id is a no-op in practice, but the sets are
    // cleared regardless so nothing accumulates across enable/disable cycles.

    _addTimer(sourceIds, create) {
        const sourceId = create();
        if (sourceId)
            sourceIds.add(sourceId);
        return sourceId;
    }

    _cancel(obj, property) {
        const sourceId = obj[property];
        if (sourceId)
            GLib.Source.remove(sourceId);
        obj[property] = 0;
    }

    _cancelAll(sourceIds) {
        for (const sourceId of sourceIds)
            GLib.Source.remove(sourceId);
        sourceIds.clear();
    }

    /** Connects and remembers the emitter, so disable() can disconnect it. */
    _connect(emitter, signal, callback) {
        const signalId = emitter.connect(signal, callback);
        this._signals.push([emitter, signalId]);
        return signalId;
    }

    // Public actions used by the indicator

    restoreWindow(window, reason) {
        if (!this._windowRecords.get(window)?.minimized)
            return false;
        return this._bringWindowHere(window, reason);
    }

    closeWindow(window) {
        if (!this._windowRecords.has(window))
            return;
        try {
            window.delete(global.get_current_time());
            this._indicator.menu.close();
            debug('tray', `requested close for "${windowTitle(window)}"`);
        } catch (e) {
            error(`could not close window: ${e.message}`);
        }
    }

    // Window tracking

    _onConfigChanged(config) {
        const trayAppsChanged = !trayAppsEqual(this._config.trayApps, config.trayApps);
        this._config = config;
        if (!trayAppsChanged) {
            // Focus bookkeeping shares config.json with the tray-app list.  Do
            // not expose and re-hide every minimized window merely because
            // lastFocusedApp changed: besides being unnecessary, that can make
            // Shell rebuild overview clones during an overview/menu transition.
            debug('config', 'configuration metadata reloaded; tray apps unchanged');
            return;
        }
        this._rebuildWmClassIndex();
        // Re-evaluate tracking rather than trusting stale records: a config edit
        // can add or remove the app a tracked window belongs to.
        for (const window of [...this._windowRecords.keys()])
            this._untrackWindow(window);
        this._scanWindows();
        this._scanNotificationSources();
        debug('config', 'configuration reloaded, tracking rebuilt');
    }

    _rebuildWmClassIndex() {
        this._wmClassIndex = matching.buildWmClassIndex(
            this._config.trayApps,
            config => wmClassKeysFor(config, Shell.AppSystem.get_default()));
        debug('match', `WM_CLASS index: ${[...this._wmClassIndex.keys()].join(', ') || '(empty)'}`);
    }

    _scanWindows() {
        for (const window of global.display.list_all_windows())
            this._considerWindow(window);
    }

    // WM_CLASS and app association are not always final at window-created time,
    // so a new window is re-examined on idle and once more after a short delay.
    _scheduleWindowChecks(window) {
        this._considerWindow(window);
        this._addTimer(this._windowTimers, () =>
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._considerWindow(window);
                return GLib.SOURCE_REMOVE;
            }));
        this._addTimer(this._windowTimers, () =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_RECHECK_DELAY_MS, () => {
                this._considerWindow(window);
                return GLib.SOURCE_REMOVE;
            }));
    }

    _considerWindow(window) {
        if (!this._enabled || this._windowRecords.has(window))
            return;
        if (!isTrayEligibleWindow(window))
            return;
        const config = this._matchWindow(window);
        if (!config)
            return;
        this._trackWindow(window, config);
    }

    _matchWindow(window) {
        // WM_CLASS first: this is the path that works for Chromium PWAs, whose
        // Shell app is the generic browser.
        for (const key of matching.windowWmClassKeys(window)) {
            const config = this._wmClassIndex.get(key);
            if (config) {
                debug('match', `window "${windowTitle(window)}" wm-class ${key} -> ${config.name}`);
                return config;
            }
        }
        const keys = matching.windowWmClassKeys(window);
        const pwaConfig = matching.matchChromiumWindowKeys(keys, this._config.trayApps);
        if (pwaConfig) {
            debug('match', `window "${windowTitle(window)}" pwa id in ${keys.join(', ')} -> ${pwaConfig.name}`);
            return pwaConfig;
        }
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const config = matching.matchApp(app, this._config.trayApps);
        if (config)
            debug('match', `window "${windowTitle(window)}" app ${app?.get_id?.()} -> ${config.name}`);
        else
            debug('match', `window "${windowTitle(window)}" wm-class ${keys.join(', ') || '(none)'} app ${app?.get_id?.()} -> no tray app`);
        return config;
    }

    _trackWindow(window, config) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const record = {
            config,
            app,
            hiddenFromWindowList: false,
            stuckForTray: false,
            minimized: window.minimized,
            signalIds: [],
        };
        this._windowRecords.set(window, record);

        record.signalIds.push(
            window.connect('notify::minimized', () => this._syncWindowTrayState(window)),
            window.connect('notify::title', () => this._indicator?.updateWindow(window)),
        );
        // Do not hold a JS reference to an unmanaged window beyond this callback.
        record.signalIds.push(window.connect('unmanaged', () => this._untrackWindow(window)));

        this._syncWindowTrayState(window);
        debug('tray', `tracking ${config.name}: "${windowTitle(window)}"`);
    }

    _untrackWindow(window, {deferWindowListRestore = false} = {}) {
        const record = this._windowRecords.get(window);
        if (!record)
            return;
        this._windowRecords.delete(window);
        for (const signalId of record.signalIds) {
            try {
                window.disconnect(signalId);
            } catch (_) {
                // An unmanaged Meta.Window may already have disposed its signals.
            }
        }
        record.signalIds.length = 0;
        this._indicator?.removeWindow(window);
        this._restoreWorkspaceOwnership(window, record);
        if (deferWindowListRestore)
            this._showWindowInListsWhenIdle(window, record);
        else
            this._showWindowInLists(window, record);
    }

    _syncWindowTrayState(window) {
        const record = this._windowRecords.get(window);
        if (!record)
            return;
        record.minimized = window.minimized;

        if (window.minimized) {
            this._hideWindowFromLists(window, record);
            this._releaseWorkspaceOwnership(window, record);
            this._indicator.addWindow(window, record.app);
            debug('tray', `minimized ${record.config.name}: "${windowTitle(window)}"`);
        } else if (record.hiddenFromWindowList) {
            // An external launcher (a second launch request, a notification from a
            // single-instance app) cannot reach our Shell.App hooks, but a
            // single-instance application normally responds to such a request by
            // presenting — and therefore unminimizing — its existing window.
            // Complete that restore on the current workspace.
            this._bringWindowHere(window, 'application presentation');
        } else {
            this._indicator.removeWindow(window);
            this._showWindowInLists(window, record);
        }
    }

    _hideWindowFromLists(window, record) {
        if (record.hiddenFromWindowList)
            return;
        try {
            window.hide_from_window_list();
            record.hiddenFromWindowList = true;
        } catch (e) {
            error(`could not hide window from Shell lists: ${e.message}`);
        }
    }

    _showWindowInLists(window, record) {
        if (!record.hiddenFromWindowList)
            return;
        try {
            window.show_in_window_list();
            record.hiddenFromWindowList = false;
        } catch (e) {
            error(`could not restore window-list visibility: ${e.message}`);
        }
    }

    _showWindowInListsWhenIdle(window, record) {
        if (!record.hiddenFromWindowList)
            return;
        record.hiddenFromWindowList = false;
        this._addTimer(this._cleanupTimers, () =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEFERRED_CLEANUP_DELAY_MS, () => {
                try {
                    window.show_in_window_list();
                } catch (e) {
                    error(`deferred window-list cleanup failed: ${e.message}`);
                }
                return GLib.SOURCE_REMOVE;
            }));
    }

    // A minimized Meta.Window still counts as occupying its workspace. Dynamic
    // workspaces consequently cannot disappear even after the window has been
    // removed from Shell's window lists. Temporarily making a tray window sticky
    // makes Shell's WorkspaceTracker ignore it. Mutter does not emit one of the
    // workspace signals that queues a recheck for this transition, so request the
    // recheck explicitly. Restore ordinary state before moving or exposing the
    // window again; windows that were already sticky are left so.
    _releaseWorkspaceOwnership(window, record) {
        if (record.stuckForTray || window.is_on_all_workspaces?.())
            return;
        try {
            window.stick();
            record.stuckForTray = true;
            Main.wm?._workspaceTracker?._queueCheckWorkspaces?.();
        } catch (e) {
            error(`could not release tray window's workspace: ${e.message}`);
        }
    }

    _restoreWorkspaceOwnership(window, record) {
        if (!record.stuckForTray)
            return;
        try {
            window.unstick();
            record.stuckForTray = false;
        } catch (e) {
            error(`could not restore tray window's workspace: ${e.message}`);
        }
    }

    // Moving a tracked window to the current workspace

    _bringWindowHere(window, reason, requestedTarget = null) {
        const record = this._windowRecords.get(window);
        if (!record)
            return false;

        const pending = this._pendingNotificationActivation;
        const requested = workspaceExists(requestedTarget)
            ? requestedTarget
            : pending?.config === record.config && workspaceExists(pending.workspace)
                ? pending.workspace
                : null;
        const target = this._config.moveToCurrentWorkspace
            ? requested ?? global.workspace_manager.get_active_workspace()
            : window.get_workspace();
        try {
            if (pending?.config === record.config)
                this._clearPendingNotificationActivation();
            this._restoreWorkspaceOwnership(window, record);
            this._showWindowInLists(window, record);
            this._indicator.removeWindow(window);
            if (window.get_workspace() !== target)
                window.change_workspace(target);
            window.unminimize();
            window.activate_with_workspace(global.get_current_time(), target);
            Main.overview.hide();
            this._indicator.menu.close();
            debug('activation', `brought "${windowTitle(window)}" to workspace `
                + `${target.index()} for ${reason}`);
            return true;
        } catch (e) {
            error(`could not restore window: ${e.message}`);
            return false;
        }
    }

    _needsToComeHere(window) {
        return window.minimized ||
            this._config.moveToCurrentWorkspace &&
                window.get_workspace() !== global.workspace_manager.get_active_workspace();
    }

    /**
     * The tracked tray window that should answer an activation of `app`, or null
     * if none needs to move.
     *
     * Preference order: a window Shell attributes to this app, then any other
     * window matched to the same config. This matters for Chromium PWAs, where a
     * notification arrives from the browser app while the window belongs to the
     * PWA. Within a group, the most recently interacted-with window wins.
     */
    _preferredWindowFor(app, config) {
        const fromApp = new Set(app?.get_windows?.() ?? []);
        const candidates = [...this._windowRecords.entries()]
            .filter(([, record]) => record.config === config)
            .map(([window]) => window)
            .filter(window => this._needsToComeHere(window));

        const rank = window => (fromApp.has(window) ? 1 : 0);
        candidates.sort((left, right) =>
            rank(right) - rank(left) || right.get_user_time() - left.get_user_time());
        return candidates[0] ?? null;
    }

    _bringAppWindowHere(app, config, reason) {
        const window = this._preferredWindowFor(app, config);
        return window ? this._bringWindowHere(window, reason) : false;
    }

    // Application activation hooks
    //
    // Shell exposes no signal for application activation, so these three
    // Shell.App methods are wrapped. See patchRegistry.js for how installation is
    // made stack-proof and reversible.

    _installAppActivationHooks() {
        this._patchAppMethod('activate',
            (app, config) => this._bringAppWindowHere(app, config, 'app activation'));
        this._patchAppMethod('activate_full',
            (app, config) => this._bringAppWindowHere(app, config, 'full app activation'));
        this._patchAppMethod('activate_window', (app, config, args) => {
            // Shell passes the specific window it wants focused (e.g. from a
            // window-switcher or a notification). Honour that window if it is one
            // of ours; otherwise fall through to the normal app-wide behaviour.
            const window = args[0];
            if (this._windowRecords.get(window)?.config !== config)
                return false;
            return this._needsToComeHere(window)
                ? this._bringWindowHere(window, 'app window activation')
                : false;
        });
    }

    // Shell.App identifies Chromium PWA windows as the generic browser in some
    // activation paths. Workspace.activate_with_focus(), however, receives the
    // exact window chosen by Shell/Brave. Intercepting it also restores the
    // intended behaviour for visible managed windows on another workspace.
    _installWindowActivationHook() {
        const extension = this;
        patchRegistry.patch(Meta.Workspace.prototype, 'activate_with_focus',
            function (original, window, timestamp) {
                if (extension._enabled && window && extension._windowRecords.has(window)) {
                    const workspace = window.get_workspace?.();
                    debug('activation', `Workspace.activate_with_focus("${windowTitle(window)}", `
                        + `workspace ${workspace?.index?.() ?? '?'})`);
                }
                if (extension._enabled && window &&
                    extension._windowRecords.has(window) &&
                    extension._needsToComeHere(window) &&
                    !extension._isMoveToWorkspaceKeybinding()) {
                    try {
                        if (extension._bringWindowHere(window, 'window activation'))
                            return undefined;
                    } catch (e) {
                        error(`window activation handler failed: ${e.message}`);
                    }
                }
                return original.call(this, window, timestamp);
            });
    }

    _isMoveToWorkspaceKeybinding() {
        const event = Clutter.get_current_event();
        if (!event || event.type() !== Clutter.EventType.KEY_PRESS)
            return false;
        const action = global.display.get_keybinding_action(
            event.get_key_code(), event.get_state());
        return MOVE_TO_WORKSPACE_ACTIONS.has(action);
    }

    _patchAppMethod(method, onTrayApp) {
        const extension = this;
        patchRegistry.patch(Shell.App.prototype, method, function (original, ...args) {
            if (extension._enabled) {
                const config = matching.matchApp(this, extension._config.trayApps);
                debug('activation', `Shell.App.${method}(${this.get_id()}) `
                    + `-> ${config ? config.name : 'not a tray app'}`);
                if (config) {
                    try {
                        if (onTrayApp(this, config, args))
                            return undefined;
                    } catch (e) {
                        error(`Shell.App.${method} handler failed: ${e.message}`);
                    }
                }
            }
            return original.apply(this, args);
        });
    }

    // Focus and last-focused-app bookkeeping

    _onFocusWindowChanged() {
        this._completePendingNotificationActivation();
        this._rememberFocusedApp();
    }

    _rememberFocusedApp() {
        const window = global.display.get_focus_window();
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window) : null;
        let appId = app?.get_id?.() ?? '';
        if (matching.isSelfOrInternalAppId(appId))
            return;
        let title = app.get_name() ?? windowTitle(window);
        // On Wayland, Shell often resolves a Chromium-family PWA window to the
        // generic browser. Record the PWA's own desktop entry instead, so
        // "Use last focused application" adds the web app, not the whole browser.
        const pwaApp = findPwaApp(window);
        if (pwaApp) {
            appId = pwaApp.get_id();
            title = pwaApp.get_name() ?? title;
        }
        const captured = {appId, title};
        const previous = loadConfig().lastFocusedApp;
        if (previous?.appId === captured.appId && previous?.title === captured.title)
            return;
        // Preferences runs in a separate process, so merge into the latest file
        // instead of writing our in-memory copy: that way focus capture can never
        // clobber a tray-app edit that landed a moment earlier.
        saveConfig({...this._config, lastFocusedApp: captured});
        debug('config', `recorded last focused app ${appId}`);
    }

    // Notification handling
    //
    // A notification from a configured app is a request to see that app. Generic
    // Chromium-family notifications lack app identity, so routing is opt-in via
    // configured URL-host hints and requires one matching PWA and one managed window.
    //
    // `notification.activate` is patched (not signal-connected) because
    // StNotification has no activation signal.

    _scanNotificationSources() {
        for (const source of Main.messageTray.getSources())
            this._watchNotificationSource(source);
    }

    _watchNotificationSource(source) {
        if (this._notificationSourceSignals.has(source))
            return;
        const added = source.connect('notification-added',
            (_source, notification) => this._considerNotification(source, notification));
        const destroyed = source.connect('destroy',
            () => this._notificationSourceSignals.delete(source));
        this._notificationSourceSignals.set(source, [added, destroyed]);

        for (const notification of source.notifications ?? [])
            this._considerNotification(source, notification);
    }

    _considerNotification(source, notification) {
        if (this._notificationHooks.has(notification))
            return;
        const config = matching.matchSource(source, this._config.trayApps);
        const deferredBrowser = !config && this._isGenericBrowserSource(source);
        if (!config && !deferredBrowser)
            return;

        const extension = this;
        const handle = patchRegistry.patchObject(notification, 'activate',
            function (original) {
                const genericBrowser = !config;
                if (extension._enabled) {
                    if (config) {
                        debug('notification',
                            `notification from ${source.app?.get_id()} -> ${config.name}`);
                        extension._queueNotificationActivation(config);
                    } else {
                        debug('notification',
                            `checking generic browser source ${source.app?.get_id()}`);
                        extension._queueBrowserNotification(source, notification);
                    }
                }
                try {
                    return original.call(this);
                } finally {
                    if (extension._enabled) {
                        const focused = global.display.get_focus_window();
                        debug('notification', `${genericBrowser ? 'generic browser' : config.name} `
                            + `notification activation returned; focus="${windowTitle(focused)}", `
                            + `workspace=${focused?.get_workspace?.()?.index?.() ?? '?'}`);
                    }
                    // GNOME's source.open() and GTK action paths do this too,
                    // but the freedesktop default-action path does not.
                    Main.panel.closeCalendar();
                }
            });
        if (handle) {
            handle.destroySignal = notification.connect('destroy', () => {
                handle.restore();
                this._notificationHooks.delete(notification);
            });
            this._notificationHooks.set(notification, handle);
        }
    }

    /**
     * True for a notification source belonging to a Chromium-family browser when
     * at least one configured tray app is a PWA. Such a notification does not say
     * which PWA it came from, so routing requires explicit host hints.
     */
    _isGenericBrowserSource(source) {
        return matching.isGenericBrowserAppId(source?.app?.get_id?.()) &&
            this._config.trayApps.some(config => matching.isChromiumPwaConfig(config));
    }

    _queueNotificationActivation(config) {
        this._clearPendingNotificationActivation();
        this._pendingNotificationActivation = {
            config,
            workspace: global.workspace_manager.get_active_workspace(),
        };
        this._pendingNotificationActivationTimer = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, NOTIFICATION_ACTIVATION_TIMEOUT_MS, () => {
                this._pendingNotificationActivation = null;
                this._pendingNotificationActivationTimer = 0;
                return GLib.SOURCE_REMOVE;
            });
    }

    _clearPendingNotificationActivation() {
        this._pendingNotificationActivation = null;
        this._cancel(this, '_pendingNotificationActivationTimer');
    }

    _completePendingNotificationActivation() {
        const pending = this._pendingNotificationActivation;
        const window = global.display.get_focus_window();
        const record = window ? this._windowRecords.get(window) : null;
        if (!pending || record?.config !== pending.config)
            return;

        // The application, not the notification source, has now identified the
        // destination window. Defer until its own presentation work has settled.
        const target = pending.workspace;
        this._clearPendingNotificationActivation();
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._enabled || !this._windowRecords.has(window))
                return GLib.SOURCE_REMOVE;
            this._bringWindowHere(window, 'notification action', target);
            return GLib.SOURCE_REMOVE;
        });
    }

    _queueBrowserNotification(source, notification) {
        const sourceId = source?.app?.get_id?.() ?? 'browser';
        const hosts = matching.notificationHosts(
            notification?.body,
            notification?.bodyMarkup,
            notification?.get_body?.());
        if (hosts.length === 0) {
            debug('notification', `generic ${sourceId}: no URL in notification text; `
                + 'left to Brave without window-tray routing');
            return;
        }

        const configs = matching.configsForNotificationHosts(hosts, this._config.trayApps)
            .filter(config => matching.isChromiumPwaConfig(config));
        if (configs.length !== 1) {
            debug('notification', `generic ${sourceId}: URL host(s) ${hosts.join(', ')} matched `
                + `${configs.length} configured PWAs; left to Brave without window-tray routing`);
            return;
        }

        const config = configs[0];
        const windows = [...this._windowRecords.entries()]
            .filter(([, record]) => record.config === config)
            .map(([window]) => window);
        if (windows.length !== 1) {
            debug('notification', `generic ${sourceId}: ${config.name} matched, but has `
                + `${windows.length} managed windows; left to Brave without window-tray routing`);
            return;
        }

        const window = windows[0];
        const workspace = global.workspace_manager.get_active_workspace();
        debug('notification', `generic ${sourceId}: URL host(s) ${hosts.join(', ')} uniquely `
            + `matched ${config.name} and one managed window`);
        // Run after Brave's own notification action, then activate the known
        // window. Do not infer identity from whichever browser window happens
        // to take focus next.
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!this._enabled || this._windowRecords.get(window)?.config !== config)
                return GLib.SOURCE_REMOVE;
            this._bringWindowHere(window, 'browser notification', workspace);
            return GLib.SOURCE_REMOVE;
        });
    }
}

// Helpers

function windowTitle(window) {
    return window?.get_title?.() ?? '(untitled)';
}

/** The installed desktop entry for a Chromium-family PWA window, or null. */
function findPwaApp(window) {
    const windowId = matching.windowWmClassKeys(window)
        .map(key => matching.extractChromiumAppId(key)).find(Boolean);
    if (!windowId)
        return null;
    return Shell.AppSystem.get_default().get_installed()
        .map(info => Shell.AppSystem.get_default().lookup_app(info.get_id()))
        .find(app => app && matching.extractChromiumAppId(app.get_id()) === windowId) ?? null;
}

function isTrayEligibleWindow(window) {
    try {
        return window.get_window_type() === Meta.WindowType.NORMAL && !window.skip_taskbar;
    } catch (_) {
        return false;
    }
}

function workspaceExists(workspace) {
    const manager = global.workspace_manager;
    return workspace && Array.from({length: manager.n_workspaces},
        (_, index) => manager.get_workspace_by_index(index)).includes(workspace);
}
