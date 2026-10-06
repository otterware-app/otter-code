import Constants from "expo-constants";

const appVariant = Constants.expoConfig?.extra?.appVariant;

export const T3_CODE_BRAND_MARK_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/otter-dev/otter-dev-ios-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/otter-nightly/otter-nightly-ios-1024.png")
      : require("../../../../assets/otter/otter-ios-1024.png");
