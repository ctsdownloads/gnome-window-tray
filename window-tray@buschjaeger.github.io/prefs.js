// Preferences for Window Tray.
//
// Runs in gnome-extensions-app's process, separate from the Shell. It reads and
// writes the same JSON file the extension watches, so edits apply immediately.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {loadConfig, saveConfig} from './config.js';
import {debug, setDebugEnabled} from './logging.js';

export default class WindowTrayPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._config = loadConfig();
        this._window = window;
        window.set_default_size(720, 560);

        const page = new Adw.PreferencesPage({
            title: 'Window Tray',
            icon_name: 'window-minimize-symbolic',
        });
        window.add(page);

        page.add(this._behaviorGroup());
        this._appsGroup = new Adw.PreferencesGroup({
            title: 'Tray applications',
            description: 'Minimizing one of these applications puts its window in the '
                + 'panel tray instead of the taskbar area.',
        });
        page.add(this._appsGroup);

        this._renderApps();
    }

    _behaviorGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Behavior',
            description: 'Minimizing a configured app puts its window in the panel tray '
                + 'and hides it from the overview, Alt+Tab, and taskbars. '
                + 'The window close button, File → Quit, and Alt+F4 keep their normal behavior.',
        });
        const moveRow = new Adw.SwitchRow({
            title: 'Move activated windows to the current workspace',
            subtitle: 'When disabled, GNOME switches to the workspace containing the window.',
            active: this._config.moveToCurrentWorkspace,
        });
        group.add(moveRow);
        moveRow.connect('notify::active', () => {
            this._config.moveToCurrentWorkspace = moveRow.active;
            this._save();
        });
        group.add(new Adw.ActionRow({
            title: 'Restore a window',
            subtitle: 'Click its tray row to restore and focus it using the workspace behavior above.',
        }));
        group.add(new Adw.ActionRow({
            title: 'Close a window',
            subtitle: 'Click the × in its tray row to send a normal close request.',
        }));
        group.add(new Adw.ActionRow({
            title: 'Matching applications',
            subtitle: 'A desktop-ID prefix matches every application whose desktop ID '
                + 'starts with it, so "firefox" also matches "firefox-browser". '
                + 'Use a full desktop ID for an exact match.',
        }));
        group.add(new Adw.ActionRow({
            title: 'Debug logging',
            subtitle: 'Writes diagnostic output to the journal while the file '
                + '~/.config/window-tray/debug exists. Toggle with the switch, then '
                + 'run: journalctl -f -o cat /usr/bin/gnome-shell',
        }));

        const debugRow = new Adw.SwitchRow({title: 'Enable debug logging'});
        group.add(debugRow);
        debugRow.connect('notify::active', () => this._writeDebugFlag(debugRow.active));

        return group;
    }

    _writeDebugFlag(enabled) {
        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'window-tray', 'debug']);
        try {
            const file = Gio.File.new_for_path(path);
            const directory = file.get_parent();
            if (enabled) {
                if (!directory.query_exists(null))
                    directory.make_directory_with_parents(null);
                file.replace_contents('all\n', null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } else if (file.query_exists(null)) {
                file.delete(null);
            }
        } catch (e) {
            debug('config', `could not update the debug flag file: ${e.message}`);
        }
        // Keep in-process state in sync so this process logs consistently too.
        setDebugEnabled(enabled);
    }

    _renderApps() {
        // Remove only the rows this method owns. The Behavior group is separate,
        // and re-adding rows the user is interacting with would lose focus.
        for (const row of this._appRows ?? [])
            this._appsGroup.remove(row);
        this._appRows = [];

        this._addEntryRow('Add application manually',
            'Enter a display name and one or more desktop-ID prefixes.',
            () => this._showApplicationDialog());

        this._addEntryRow('Use last focused application',
            'Adds the application that was focused before opening this window.',
            () => {
                const focused = loadConfig().lastFocusedApp;
                if (!focused?.appId) {
                    this._showNoFocusedAppDialog();
                    return;
                }
                this._showApplicationDialog({
                    name: focused.title || focused.appId.replace(/\.desktop$/i, ''),
                    desktopIdPrefixes: [focused.appId.replace(/\.desktop$/i, '')],
                });
            });

        for (const app of this._config.trayApps) {
            const row = new Adw.ActionRow({
                title: app.name || 'Unnamed application',
                subtitle: [
                    `desktop-ID prefix: ${app.desktopIdPrefixes.join(', ')}`,
                    app.notificationDomains?.length
                        ? `notification domains: ${app.notificationDomains.join(', ')}`
                        : null,
                ].filter(Boolean).join(' · '),
            });

            const edit = new Gtk.Button({label: 'Edit', valign: Gtk.Align.CENTER});
            edit.connect('clicked', () => this._showApplicationDialog(app, updated => {
                Object.assign(app, updated);
                this._save();
                this._renderApps();
            }));

            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: 'Remove from tray applications',
                valign: Gtk.Align.CENTER,
            });
            remove.connect('clicked', () => {
                this._config.trayApps.splice(this._config.trayApps.indexOf(app), 1);
                this._save();
                this._renderApps();
            });

            row.add_suffix(edit);
            row.add_suffix(remove);
            row.activatable_widget = edit;
            this._appsGroup.add(row);
            this._appRows.push(row);
        }
    }

    _addEntryRow(title, subtitle, callback) {
        // Entry rows are tracked separately from app rows so a re-render can
        // rebuild the whole set without touching the debug switch.
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.Button({label: 'Add', valign: Gtk.Align.CENTER});
        button.connect('clicked', callback);
        row.add_suffix(button);
        row.activatable_widget = button;
        this._appsGroup.add(row);
        this._appRows.push(row);
    }

    _save() {
        saveConfig(this._config);
    }

    _showApplicationDialog(initial = {}, onSave = null) {
        const dialog = new Adw.Dialog({
            title: 'Tray application',
            content_width: 460,
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 18,
            margin_bottom: 18,
            margin_start: 18,
            margin_end: 18,
        });
        const name = new Gtk.Entry({
            placeholder_text: 'Mattermost',
            text: initial.name ?? '',
        });
        const prefixes = new Gtk.Entry({
            placeholder_text: 'Mattermost, mattermost-desktop',
            text: (initial.desktopIdPrefixes ?? []).join(', '),
        });
        const domains = new Gtk.Entry({
            placeholder_text: 'chat.example.com, mail.example.org',
            text: (initial.notificationDomains ?? []).join(', '),
        });
        for (const [labelText, entry] of [
            ['Display name', name],
            ['Desktop-ID prefixes (comma-separated)', prefixes],
            ['Notification site domains (optional, comma-separated)', domains],
        ]) {
            box.append(new Gtk.Label({label: labelText, xalign: 0}));
            box.append(entry);
        }
        box.append(new Gtk.Label({
            label: 'Uses the first URL in a generic Brave/Chromium notification body as a hint. '
                + 'Routing happens only when exactly one configured app matches.',
            xalign: 0,
            wrap: true,
        }));

        const errorLabel = new Gtk.Label({
            label: '',
            xalign: 0,
            visible: false,
        });
        errorLabel.add_css_class('dim-label');
        box.append(errorLabel);

        const buttons = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            halign: Gtk.Align.END,
            spacing: 6,
        });
        const cancel = new Gtk.Button({label: 'Cancel'});
        const save = new Gtk.Button({label: onSave ? 'Save' : 'Add'});
        save.add_css_class('suggested-action');
        cancel.connect('clicked', () => dialog.close());
        save.connect('clicked', () => {
            const desktopIdPrefixes = [...new Set(prefixes.text
                .split(',').map(item => item.trim()).filter(Boolean))];
            if (desktopIdPrefixes.length === 0) {
                errorLabel.label = 'Enter at least one desktop ID prefix.';
                errorLabel.visible = true;
                return;
            }
            const updated = {
                name: name.text.trim() || 'Unnamed application',
                desktopIdPrefixes,
                notificationDomains: [...new Set(domains.text
                    .split(',').map(item => item.trim().toLowerCase()
                        .replace(/^https?:\/\//, '').split(/[/:?#]/, 1)[0])
                    .filter(Boolean))],
            };
            if (onSave) {
                onSave(updated);
            } else {
                this._config.trayApps.push(updated);
                this._save();
                this._renderApps();
            }
            dialog.close();
        });
        buttons.append(cancel);
        buttons.append(save);
        box.append(buttons);

        dialog.child = box;
        dialog.present(this._window);
    }

    _showNoFocusedAppDialog() {
        const dialog = new Adw.AlertDialog({
            heading: 'No application recorded',
            body: 'Focus the application you want to add, then reopen Window Tray settings.',
        });
        dialog.add_response('ok', 'OK');
        dialog.set_default_response('ok');
        dialog.present(this._window);
    }
}
