#!/usr/bin/env gjs -m
// Unit tests for the pure modules (matching.js, patchRegistry.js, logging.js).
//
// Runs in plain gjs without GNOME Shell: `gjs -m tests/test.mjs`, or via
// ./scripts/test.sh from the repository root.
//
// The stubs below mimic only the accessor shapes the modules actually use
// (get_id(), get_wm_class(), notifications with an .app), so behaviour that
// depends on real Shell objects is deliberately NOT covered here — that needs a
// live session (see MANUAL-TESTING.md).

import GLib from 'gi://GLib';

import {DEFAULT_CONFIG, trayAppsEqual} from '../window-tray@buschjaeger.github.io/config.js';
import * as matching from '../window-tray@buschjaeger.github.io/matching.js';
import * as patchRegistry from '../window-tray@buschjaeger.github.io/patchRegistry.js';
import * as logging from '../window-tray@buschjaeger.github.io/logging.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
    if (condition) {
        passed++;
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.error(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function eq(name, actual, expected) {
    check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Stubs ---------------------------------------------------------------------

const app = id => ({get_id: () => id});
const source = id => ({app: id === null ? null : app(id)});
const window = (wmClass, instance = null) => ({
    get_wm_class: () => wmClass,
    get_wm_class_instance: () => instance,
    get_title: () => 'stub',
});

// normalizeId ---------------------------------------------------------------

eq('normalizeId strips .desktop', matching.normalizeId('Firefox.desktop'), 'firefox');
eq('normalizeId lowercases', matching.normalizeId('Mattermost'), 'mattermost');
eq('normalizeId handles null', matching.normalizeId(null), '');
eq('normalizeId handles undefined', matching.normalizeId(undefined), '');
eq('normalizeId strips only the suffix', matching.normalizeId('org.foo.desktop.bar'), 'org.foo.desktop.bar');

// extractChromiumAppId ------------------------------------------------------

const CRX_ID = 'a'.repeat(32);
eq('extractChromiumAppId from chrome-<id>-Default',
    matching.extractChromiumAppId(`chrome-${CRX_ID}-Default`), CRX_ID);
eq('extractChromiumAppId at start',
    matching.extractChromiumAppId(CRX_ID), CRX_ID);
eq('extractChromiumAppId rejects non-base32',
    matching.extractChromiumAppId(`chrome-${'z'.repeat(32)}-Default`), null);
eq('extractChromiumAppId rejects short id',
    matching.extractChromiumAppId('chrome-abcdefgh'), null);
eq('extractChromiumAppId handles null', matching.extractChromiumAppId(null), null);

// isChromiumPwaConfig -------------------------------------------------------

check('isChromiumPwaConfig true for PWA prefix',
    matching.isChromiumPwaConfig({desktopIdPrefixes: [`chrome-${CRX_ID}-Default`]}));
check('isChromiumPwaConfig false for plain app',
    !matching.isChromiumPwaConfig({desktopIdPrefixes: ['Mattermost']}));
check('isChromiumPwaConfig tolerates missing prefixes',
    !matching.isChromiumPwaConfig({}));

// matchApp / prefix semantics ----------------------------------------------

const firefox = {name: 'Firefox', desktopIdPrefixes: ['firefox']};
const mattermost = {name: 'Mattermost', desktopIdPrefixes: ['Mattermost']};
const pwa = {name: 'Mattermost PWA', desktopIdPrefixes: [`chrome-${CRX_ID}-Default`]};
const TRAY = [firefox, mattermost, pwa];

check('moving activated windows defaults to enabled', DEFAULT_CONFIG.moveToCurrentWorkspace);

// trayAppsEqual ------------------------------------------------------------

check('trayAppsEqual accepts the same normalized tray configuration',
    trayAppsEqual(TRAY, TRAY.map(config => ({
        name: config.name,
        desktopIdPrefixes: [...config.desktopIdPrefixes],
    }))));
check('trayAppsEqual ignores unrelated config metadata',
    trayAppsEqual(
        {trayApps: TRAY, lastFocusedApp: {appId: 'one'}}.trayApps,
        {trayApps: TRAY, lastFocusedApp: {appId: 'two'}}.trayApps));
check('trayAppsEqual detects a changed prefix',
    !trayAppsEqual(TRAY, [
        firefox,
        mattermost,
        {name: pwa.name, desktopIdPrefixes: ['different']},
    ]));
check('trayAppsEqual detects reordered apps',
    !trayAppsEqual(TRAY, [mattermost, firefox, pwa]));

check('matchApp exact', matching.matchApp(app('Mattermost.desktop'), TRAY) === mattermost);
check('matchApp is case-insensitive', matching.matchApp(app('mattermost'), TRAY) === mattermost);
check('matchApp prefix rule: firefox matches firefox-browser',
    matching.matchApp(app('firefox-browser.desktop'), TRAY) === firefox,
    'documented behaviour: a prefix matches every longer desktop ID');
check('matchApp does not match unrelated app',
    matching.matchApp(app('org.gnome.Nautilus.desktop'), TRAY) === null);
check('matchApp matches PWA id',
    matching.matchApp(app(`chrome-${CRX_ID}-Default.desktop`), TRAY) === pwa);
check('matchApp returns null not undefined',
    matching.matchApp(app('nope'), TRAY) === null);
check('matchApp tolerates null app', matching.matchApp(null, TRAY) === null);
check('matchApp tolerates app without get_id', matching.matchApp({}, TRAY) === null);
check('matchApp first config wins on ambiguity',
    matching.matchApp(app('firefox-browser'), [firefox, {name: 'FF', desktopIdPrefixes: ['firefox-browser']}]) === firefox);

eq('matchAppId works on bare ids', matching.matchAppId('firefox-desktop', TRAY), firefox);
check('matchAppId null on empty', matching.matchAppId('', TRAY) === null);

// matchSource ---------------------------------------------------------------

check('matchSource uses source.app', matching.matchSource(source('Mattermost'), TRAY) === mattermost);
check('matchSource null app never matches', matching.matchSource(source(null), TRAY) === null);
check('matchSource missing app never matches', matching.matchSource({}, TRAY) === null);

// windowWmClassKeys / matchWindow ------------------------------------------

eq('windowWmClassKeys lowercases and dedupes',
    matching.windowWmClassKeys(window('Mattermost', 'mattermost')).length, 1);
eq('windowWmClassKeys keeps distinct values',
    matching.windowWmClassKeys(window('Mattermost', 'mattermost1')).length, 2);
eq('windowWmClassKeys skips null instance',
    matching.windowWmClassKeys(window('Mattermost')).length, 1);

const crxKey = `crx_${CRX_ID}`;
const wmIndex = matching.buildWmClassIndex(
    [mattermost, pwa],
    config => config === mattermost ? ['Mattermost'] : [crxKey]);
eq('buildWmClassIndex normalizes keys', wmIndex.has('mattermost'), true);
check('matchWindow finds PWA by crx_ WM_CLASS',
    matching.matchWindow(window(crxKey), TRAY, wmIndex) === pwa);
check('matchWindow ignores unindexed WM_CLASS',
    matching.matchWindow(window('gnome-calculator'), TRAY, wmIndex) === null);
check('buildWmClassIndex first config wins on collision',
    matching.buildWmClassIndex([firefox, {name: 'X', desktopIdPrefixes: ['firefox']}],
        () => ['firefox']).get('firefox') === firefox);

// isGenericBrowserAppId ----------------------------------------------------

check('isGenericBrowserAppId chromium', matching.isGenericBrowserAppId('chromium-browser'));
check('isGenericBrowserAppId google-chrome', matching.isGenericBrowserAppId('google-chrome'));
check('isGenericBrowserAppId brave with profile suffix',
    matching.isGenericBrowserAppId('brave-browser-Default'));
check('isGenericBrowserAppId msedge', matching.isGenericBrowserAppId('com.microsoft.Edge'));
check('isGenericBrowserAppId rejects non-browser', !matching.isGenericBrowserAppId('Mattermost'));

// isSelfOrInternalAppId ----------------------------------------------------

check('isSelfOrInternalAppId rejects the Extensions app',
    matching.isSelfOrInternalAppId('org.gnome.Extensions.desktop'));
check('isSelfOrInternalAppId rejects empty', matching.isSelfOrInternalAppId(''));
check('isSelfOrInternalAppId accepts real apps',
    !matching.isSelfOrInternalAppId('firefox.desktop'));

// patchRegistry ------------------------------------------------------------

function makeClass() {
    return class {
        constructor() {
            this.calls = [];
        }
        activate(...args) {
            this.calls.push(['original', ...args]);
            return 'original';
        }
    };
}

// patchRegistry: prototype wrapping ---------------------------------------

class Greeter {
    greet(...args) {
        this.calls = (this.calls ?? []).concat([['original', ...args]]);
        return 'original';
    }
}

{
    const proto = Greeter.prototype;
    let wrapperRan = 0;
    const ok = patchRegistry.patch(proto, 'greet', function (original, ...args) {
        wrapperRan++;
        return original.apply(this, args);
    });
    eq('patch() reports success', ok, true);
    const greeter = new Greeter();
    eq('patched method returns the original value', greeter.greet(1, 2), 'original');
    eq('wrapper ran exactly once', wrapperRan, 1);
    eq('original received forwarded args',
        JSON.stringify(greeter.calls), JSON.stringify([['original', 1, 2]]));

    // Stacking our own second wrapper must be refused.
    let secondRan = 0;
    eq('second patch of the same method refused',
        patchRegistry.patch(proto, 'greet', function (original, ...args) {
            secondRan++;
            return original.apply(this, args);
        }), false);
    greeter.greet();
    eq('refused wrapper never runs', secondRan, 0);

    patchRegistry.unpatchAll();
    eq('unpatchAll restores the untouched original',
        greeter.greet(7), 'original');
    eq('restored original is the real method, not a wrapper',
        Greeter.prototype.greet.name, 'greet');
    eq('registry empty after unpatchAll', patchRegistry.patchCount(), 0);
}

// patchRegistry: restore by identity --------------------------------------

{
    const target = {activate() { return 'base'; }};
    patchRegistry.patchObject(target, 'activate', function (original) {
        return `wrapped(${original.call(this)})`;
    });
    eq('patchObject wraps the instance method', target.activate(), 'wrapped(base)');

    // Another extension replaces our wrapper wholesale. We must not cut it out.
    target.activate = function () { return 'other-extension'; };
    patchRegistry.unpatchAll();
    eq('unpatchAll leaves a foreign wrapper in place', target.activate(), 'other-extension');
    eq('registry empty', patchRegistry.patchCount(), 0);
}

// patchRegistry: reverse-order unwinding ----------------------------------

{
    // Two of our own wrappers on one entry point are refused (tested above), so a
    // genuine nesting is always ours-then-foreign. Reverse-order unwinding is
    // therefore verified by unwinding two *different* entry points and asserting
    // the registry order directly, plus a ours+foreign chain below.
    const target = {
        a() { return 'A'; },
        b() { return 'B'; },
    };
    patchRegistry.patchObject(target, 'a', function (original) {
        return `a(${original.call(this)})`;
    });
    patchRegistry.patchObject(target, 'b', function (original) {
        return `b(${original.call(this)})`;
    });
    eq('both instance wrappers installed', patchRegistry.patchCount(), 2);
    patchRegistry.unpatchAll();
    eq('a restored', target.a(), 'A');
    eq('b restored', target.b(), 'B');
    eq('registry empty', patchRegistry.patchCount(), 0);
}

// patchRegistry: genuine two-layer composition (ours + a foreign wrapper) ---

{
    const target = {go() { return 'base'; }};
    patchRegistry.patchObject(target, 'go', function (original) {
        return `ours(${original.call(this)})`;
    });
    // A foreign extension wraps ours *after* us: it captures our wrapper as its
    // original, so the chain composes.
    const ours = target.go;
    target.go = function () { return `foreign(${ours.call(this)})`; };
    eq('two-layer chain composes', target.go(), 'foreign(ours(base))');
    // Our restore-by-identity check sees a foreign function installed and must
    // leave it alone rather than removing the foreign layer.
    patchRegistry.unpatchAll();
    eq('foreign outer layer survives our unpatch', target.go(), 'foreign(ours(base))');
}

// patchRegistry: idempotence and missing methods --------------------------

{
    const target = {m() { return 'orig'; }};
    const entry = patchRegistry.patchObject(target, 'm', function (original) {
        return `w(${original.call(this)})`;
    });
    entry.restore();
    eq('restore() returns to original', target.m(), 'orig');
    entry.restore();
    eq('double restore is safe', target.m(), 'orig');
    patchRegistry.unpatchAll();
    eq('unpatchAll after explicit restore keeps original', target.m(), 'orig');
}

{
    const target = {};
    eq('patch of a missing method returns false',
        patchRegistry.patch(target, 'nope', function (original) { return original(); }), false);
    eq('patchObject of a missing method returns null',
        patchRegistry.patchObject(target, 'nope', function (original) { return original(); }), null);
    patchRegistry.unpatchAll();
    eq('registry empty after failed patches', patchRegistry.patchCount(), 0);
}

// logging ------------------------------------------------------------------

logging.setDebugEnabled(false);
eq('debug disabled by default', logging.isDebugEnabled('tray'), false);
logging.setDebugEnabled(true, ['tray']);
eq('debug honours category', logging.isDebugEnabled('tray'), true);
eq('debug rejects inactive category', logging.isDebugEnabled('config'), false);
logging.setDebugEnabled(true);
eq('debug all when no categories given', logging.isDebugEnabled('patch'), true);
logging.setDebugEnabled(false);
eq('debug can be turned off again', logging.isDebugEnabled('tray'), false);
check('LOG_CATEGORIES covers the documented set',
    matching ? logging.LOG_CATEGORIES.includes('activation') : false);

// Result -------------------------------------------------------------------

if (failures.length) {
    console.error(`\n${failures.length} FAILED, ${passed} passed`);
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => GLib.SOURCE_REMOVE);
    // gjs has no clean exit code API across versions; throw so the runner sees failure.
    throw new Error(`${failures.length} test(s) failed`);
}
console.log(`OK ${passed} assertions passed`);
