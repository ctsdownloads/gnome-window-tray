// Pure application/window matching logic.
//
// This module has no dependency on GNOME Shell, St, or global state. It takes
// plain strings and objects with a few accessor methods, which makes it unit
// testable in plain `gjs -m` (see tests/test-matching.mjs). Everything that
// decides *which configured tray app an application or window belongs to* lives
// here, so the fragile Shell-facing code in extension.js stays small.

/** Strips `.desktop` and lowercases, the canonical form for comparison. */
export function normalizeId(value) {
    return String(value ?? '').replace(/\.desktop$/i, '').toLowerCase();
}

/**
 * Chromium derives the WM_CLASS of a PWA window from a 32-character
 * extension/app id (`crx_<id>`), and its desktop ID embeds the same id
 * (`chrome-<id>-Default`). This extracts it.
 */
export function extractChromiumAppId(value) {
    // Matches every form a Chromium-family PWA id appears in:
    //   X11 WM_CLASS            crx_<id>
    //   Wayland app_id          brave-<id>-Default, chrome-<id>-Profile_1, ...
    //   desktop IDs             brave-<id>-Default, com.brave.Browser.flextop.brave-<id>-Default
    return String(value ?? '').match(/(?:^|[-_.])([a-p]{32})(?:[-_.]|$)/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Finds the PWA tray config whose configured desktop ID carries the same
 * Chromium app id as one of the window's WM_CLASS keys. This covers native
 * Wayland, where the window reports `<browser>-<id>-<profile>` instead of the
 * `crx_<id>` value that desktop files declare as StartupWMClass.
 */
export function matchChromiumWindowKeys(keys, trayApps) {
    for (const key of keys ?? []) {
        const windowId = extractChromiumAppId(key);
        if (!windowId)
            continue;
        const config = trayApps?.find(candidate =>
            prefixesOf(candidate).some(prefix => extractChromiumAppId(prefix) === windowId));
        if (config)
            return config;
    }
    return null;
}

/** True if any prefix looks like a Chromium PWA desktop ID. */
export function isChromiumPwaConfig(config) {
    return prefixesOf(config).some(prefix => extractChromiumAppId(prefix) !== null);
}

function prefixesOf(config) {
    return config?.desktopIdPrefixes ?? [];
}

/**
 * Extract the first URL hostname from notification body text. Some Chromium
 * notifications put the sending site's URL first; the browser does not expose
 * that origin as notification metadata.
 */
export function notificationHosts(...parts) {
    const text = parts.filter(value => typeof value === 'string').join('\n')
        .replace(/&amp;/gi, '&').replace(/&#x2f;/gi, '/').replace(/&#47;/g, '/');
    for (const match of text.matchAll(/https?:\/\/([^\s<>"'`]+)/gi)) {
        const candidate = match[1].replace(/[),.;!?\]]+$/, '');
        try {
            return [new URL(`https://${candidate}`).hostname.toLowerCase()];
        } catch (_) {
            // Ignore malformed links in notification markup or prose.
        }
    }
    return [];
}

function domainMatches(host, domain) {
    const normalized = String(domain ?? '').toLowerCase().replace(/^\.+|\.+$/g, '');
    return normalized && (host === normalized || host.endsWith(`.${normalized}`));
}

/** Return configs uniquely identified by explicit notification-domain hints. */
export function configsForNotificationHosts(hosts, trayApps) {
    const matches = new Set();
    for (const config of trayApps ?? []) {
        if ((config.notificationDomains ?? []).some(domain =>
            hosts.some(host => domainMatches(host, domain))))
            matches.add(config);
    }
    return [...matches];
}

/**
 * The match rule: a configured prefix matches any application whose normalized
 * desktop ID *starts with* it. So `firefox` also matches `firefox-browser`.
 * Use a full desktop ID for an effectively exact match.
 */
export function matchesPrefix(normalizedAppId, prefix) {
    return normalizedAppId.startsWith(normalizeId(prefix));
}

/**
 * Finds the tray configuration for an app-like object (anything exposing
 * `get_id()`), or `null`. First match in configuration order wins.
 */
export function matchApp(app, trayApps) {
    const appId = normalizeId(app?.get_id?.());
    if (!appId)
        return null;
    return trayApps?.find(config =>
        prefixesOf(config).some(prefix => matchesPrefix(appId, prefix))) ?? null;
}

/** Finds the tray configuration for an app-like object by explicit desktop ID. */
export function matchAppId(appId, trayApps) {
    const normalized = normalizeId(appId);
    if (!normalized)
        return null;
    return trayApps?.find(config =>
        prefixesOf(config).some(prefix => matchesPrefix(normalized, prefix))) ?? null;
}

/**
 * Notification sources carry the originating app, so matching is delegated to
 * it. A source without an app never matches.
 */
export function matchSource(source, trayApps) {
    return matchApp(source?.app, trayApps);
}

/**
 * Builds a WM_CLASS/instance -> config index.
 *
 * `wmClassKeysFor(config)` must return the already-lowercased WM_CLASS values
 * that identify this config, which lets callers supply both the resolved
 * `StartupWMClass` from the app info and the synthetic `crx_<id>` form.
 *
 * Earlier configs win on collision, matching `matchApp`'s first-match rule.
 */
export function buildWmClassIndex(trayApps, wmClassKeysFor) {
    const index = new Map();
    for (const config of trayApps ?? []) {
        for (const key of wmClassKeysFor(config) ?? []) {
            const normalized = normalizeId(key);
            if (normalized && !index.has(normalized))
                index.set(normalized, config);
        }
    }
    return index;
}

/**
 * Resolves a window to its tray config.
 *
 * Tries the index by WM_CLASS and WM_CLASS instance (the reliable path, and the
 * only one that works for Chromium PWAs whose Shell app resolves to the generic
 * browser), then falls back to desktop-ID prefix matching.
 */
export function matchWindow(window, trayApps, wmClassIndex) {
    for (const key of [window?.get_wm_class?.(), window?.get_wm_class_instance?.()]) {
        const config = key ? wmClassIndex?.get?.(normalizeId(key)) : null;
        if (config)
            return config;
    }
    return matchChromiumWindowKeys(windowWmClassKeys(window), trayApps);
}

/** Keys to probe for a window, lowercased, without duplicates. */
export function windowWmClassKeys(window) {
    return [...new Set([window?.get_wm_class?.(), window?.get_wm_class_instance?.()]
        .filter(Boolean).map(value => normalizeId(value)))];
}

/** True for ids that should never be recorded as the last focused app. */
export function isSelfOrInternalAppId(appId) {
    const normalized = normalizeId(appId);
    return !normalized || normalized.startsWith('org.gnome.extensions');
}

/** Browser desktop IDs whose notifications may belong to a PWA. */
export const GENERIC_BROWSER_IDS = Object.freeze([
    'brave-browser', 'google-chrome', 'chromium', 'chromium-browser',
]);

/** True if a desktop ID belongs to the Chromium/Edge/Brave browser family. */
export function isGenericBrowserAppId(appId) {
    const normalized = normalizeId(appId);
    // Edge's desktop ID is com.microsoft.Edge, and its PWA notification sources
    // embed that id, so a plain prefix test is the right shape here.
    return GENERIC_BROWSER_IDS.includes(normalized) ||
        GENERIC_BROWSER_IDS.some(id => normalized.startsWith(`${id}-`)) ||
        normalized.startsWith('com.microsoft.edge') ||
        normalized.startsWith('microsoft-edge');
}
