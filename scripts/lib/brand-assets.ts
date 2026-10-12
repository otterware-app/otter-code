export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/otter-dev/app-icon.icon",
  developmentIosIconPng: "assets/otter-dev/otter-dev-ios-1024.png",
  developmentUniversalIconPng: "assets/otter-dev/otter-dev-universal-1024.png",

  productionIconComposerProject: "assets/otter/app-icon.icon",
  productionIosIconPng: "assets/otter/otter-ios-1024.png",
  productionMacIconPng: "assets/otter/otter-macos-1024.png",
  productionLinuxIconPng: "assets/otter/otter-universal-1024.png",
  productionWindowsIconIco: "assets/otter/otter-windows.ico",
  productionWebFaviconIco: "assets/otter/otter-web-favicon.ico",
  productionWebFavicon16Png: "assets/otter/otter-web-favicon-16x16.png",
  productionWebFavicon32Png: "assets/otter/otter-web-favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/otter/otter-web-apple-touch-180.png",
  productionWebIcon192Png: "assets/otter/otter-web-icon-192x192.png",
  productionWebIcon512Png: "assets/otter/otter-web-icon-512x512.png",
  productionWebFaviconSvg: "assets/otter/otter-web-favicon.svg",

  nightlyIconComposerProject: "assets/otter-nightly/app-icon.icon",
  nightlyIosIconPng: "assets/otter-nightly/otter-nightly-ios-1024.png",
  nightlyMacIconPng: "assets/otter-nightly/otter-nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/otter-nightly/otter-nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/otter-nightly/otter-nightly-windows.ico",
  nightlyWebFaviconIco: "assets/otter-nightly/otter-nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/otter-nightly/otter-nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/otter-nightly/otter-nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/otter-nightly/otter-nightly-web-apple-touch-180.png",
  nightlyWebIcon192Png: "assets/otter-nightly/otter-nightly-web-icon-192x192.png",
  nightlyWebIcon512Png: "assets/otter-nightly/otter-nightly-web-icon-512x512.png",
  nightlyWebFaviconSvg: "assets/otter-nightly/otter-nightly-web-favicon.svg",

  developmentDesktopIconPng: "assets/otter-dev/otter-dev-macos-1024.png",
  developmentWindowsIconIco: "assets/otter-dev/otter-dev-windows.ico",
  developmentWebFaviconIco: "assets/otter-dev/otter-dev-web-favicon.ico",
  developmentWebFavicon16Png: "assets/otter-dev/otter-dev-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/otter-dev/otter-dev-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/otter-dev/otter-dev-web-apple-touch-180.png",
  developmentWebIcon192Png: "assets/otter-dev/otter-dev-web-icon-192x192.png",
  developmentWebIcon512Png: "assets/otter-dev/otter-dev-web-icon-512x512.png",
  developmentWebFaviconSvg: "assets/otter-dev/otter-dev-web-favicon.svg",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  icon192Png: "icon-192x192.png",
  icon512Png: "icon-512x512.png",
  faviconSvg: "favicon.svg",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.developmentWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.developmentWebIcon512Png,
    faviconSvg: BRAND_ASSET_PATHS.developmentWebFaviconSvg,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
    faviconSvg: BRAND_ASSET_PATHS.nightlyWebFaviconSvg,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.productionWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.productionWebIcon512Png,
    faviconSvg: BRAND_ASSET_PATHS.productionWebFaviconSvg,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    {
      sourceRelativePath: sourcePaths.icon192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.icon512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon512Png}`,
    },
    {
      sourceRelativePath: sourcePaths.faviconSvg,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconSvg}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
