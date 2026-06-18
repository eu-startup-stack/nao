/* @license Enterprise */

import { useEffect } from 'react';

import { brandingAssetUrl, useBranding } from '@/hooks/use-branding';

const DEFAULT_TITLE = 'nao — Chat with your data';
const DEFAULT_FAVICON = '/favicon.ico';
const PRIMARY_COLOR_STYLE_ID = 'branding-primary-color';

/**
 * Sync the browser tab (title + favicon) and the brand color with the active
 * white-label branding. Restores defaults whenever the feature is disabled or no
 * override is set so an admin toggling the license off does not strand the page
 * with stale chrome.
 */
export function BrandingHead() {
	const branding = useBranding();

	useEffect(() => {
		const title = branding.enabled && branding.tabTitle ? branding.tabTitle : DEFAULT_TITLE;
		document.title = title;
	}, [branding.enabled, branding.tabTitle]);

	useEffect(() => {
		const href =
			branding.enabled && branding.hasFavicon ? brandingAssetUrl('favicon', branding.updatedAt) : DEFAULT_FAVICON;
		setFaviconHref(href);
		return () => setFaviconHref(DEFAULT_FAVICON);
	}, [branding.enabled, branding.hasFavicon, branding.updatedAt]);

	useEffect(() => {
		const color = branding.enabled ? branding.primaryColor : null;
		setPrimaryColor(color);
		return () => setPrimaryColor(null);
	}, [branding.enabled, branding.primaryColor]);

	return null;
}

/**
 * Override the brand color CSS variables with a custom hex color. Derives the
 * gradient stops from the single color so buttons and accents keep their depth.
 * Passing null removes the override and restores the stylesheet defaults.
 */
function setPrimaryColor(color: string | null) {
	const existing = document.getElementById(PRIMARY_COLOR_STYLE_ID);
	if (!color) {
		existing?.remove();
		return;
	}
	const css = `:root, .dark {
	--primary: ${color};
	--violet: ${color};
	--gradient-brand: linear-gradient(180deg, ${color} 0%, color-mix(in oklab, ${color}, white 14%) 100%);
	--gradient-brand-hover: linear-gradient(180deg, color-mix(in oklab, ${color}, white 14%) 0%, color-mix(in oklab, ${color}, white 28%) 100%);
	--gradient-brand-border: linear-gradient(180deg, ${color} 0%, color-mix(in oklab, ${color}, black 20%) 50.48%, color-mix(in oklab, ${color}, white 40%) 100%);
}`;
	const style = (existing as HTMLStyleElement | null) ?? document.createElement('style');
	style.id = PRIMARY_COLOR_STYLE_ID;
	if (style.textContent !== css) {
		style.textContent = css;
	}
	if (!existing) {
		document.head.appendChild(style);
	}
}

function setFaviconHref(href: string) {
	let link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
	if (!link) {
		link = document.createElement('link');
		link.rel = 'icon';
		document.head.appendChild(link);
	}
	if (link.getAttribute('href') !== href) {
		link.setAttribute('href', href);
	}
}
