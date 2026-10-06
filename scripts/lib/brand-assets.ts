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

  nightlyIconComposerProject: "assets/otter-nightly/app-icon.icon",
  nightlyIosIconPng: "assets/otter-nightly/otter-nightly-ios-1024.png",
  nightlyMacIconPng: "assets/otter-nightly/otter-nightly-macos-1024.png",
  nightlyLinuxIconPng: "assets/otter-nightly/otter-nightly-universal-1024.png",
  nightlyWindowsIconIco: "assets/otter-nightly/otter-nightly-windows.ico",
  nightlyWebFaviconIco: "assets/otter-nightly/otter-nightly-web-favicon.ico",
  nightlyWebFavicon16Png: "assets/otter-nightly/otter-nightly-web-favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/otter-nightly/otter-nightly-web-favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/otter-nightly/otter-nightly-web-apple-touch-180.png",

  developmentDesktopIconPng: "assets/otter-dev/otter-dev-macos-1024.png",
  developmentWindowsIconIco: "assets/otter-dev/otter-dev-windows.ico",
  developmentWebFaviconIco: "assets/otter-dev/otter-dev-web-favicon.ico",
  developmentWebFavicon16Png: "assets/otter-dev/otter-dev-web-favicon-16x16.png",
  developmentWebFavicon32Png: "assets/otter-dev/otter-dev-web-favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/otter-dev/otter-dev-web-apple-touch-180.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export function resolveWebAssetBrandForPackageVersion(version: string): WebAssetBrand {
  return /^[^-+]+-(?:nightly|preview)\./.test(version) ? "nightly" : "production";
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
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
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
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
