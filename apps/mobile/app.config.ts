// LINKOS native app (Expo / React Native / expo-router).
//
// Requires a development build (`npx expo prebuild && npx expo run:ios|android`): BLE (react-native-ble-plx,
// react-native-ble-advertiser) and on-device OCR (@react-native-ml-kit/text-recognition) are native modules that
// do not run in Expo Go.
//
// Deep links (F-182 모바일 딥링크): https://<LINKOS_DOMAIN>/x/{token}, /c/{code}, /n/{tagId}
//   iOS  — associatedDomains below + apps/web/public/.well-known/apple-app-site-association.
//          Replace TEAMID in the AASA file with the Apple Developer Team ID (appIDs "TEAMID.app.linkos.ios").
//   Android — intentFilters(autoVerify) below + apps/web/public/.well-known/assetlinks.json.
//          The fingerprint in assetlinks.json is a PLACEHOLDER (all zeros). Replace it with the SHA-256 of the
//          release signing certificate (Play Console → App integrity → App signing key certificate, or
//          `keytool -list -v -keystore release.keystore`), and add the upload key's fingerprint for internal builds.
import type { ExpoConfig } from "expo/config";

const domain = process.env.LINKOS_DOMAIN ?? "linkos.app";
const apiOrigin = process.env.EXPO_PUBLIC_API_ORIGIN ?? `https://${domain}`;

const config: ExpoConfig = {
  name: "LINKOS",
  slug: "linkos",
  scheme: "linkos",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  backgroundColor: "#0E0E10",
  ios: {
    bundleIdentifier: "app.linkos.ios",
    supportsTablet: false,
    associatedDomains: [`applinks:${domain}`, `webcredentials:${domain}`, `appclips:${domain}`],
    infoPlist: {
      NSCameraUsageDescription: "명함을 촬영해 연락처로 저장하고, 오프라인 교환 패스를 스캔합니다.",
      NSBluetoothAlwaysUsageDescription: "교환 화면을 연 동안에만 근처 LINKOS 사용자를 찾고 짧은 임시 ID를 알립니다. 개인정보는 블루투스로 보내지 않습니다.",
    },
  },
  android: {
    package: "app.linkos.android",
    permissions: [
      "android.permission.CAMERA",
      "android.permission.BLUETOOTH_SCAN",
      "android.permission.BLUETOOTH_ADVERTISE",
      "android.permission.BLUETOOTH_CONNECT",
      "android.permission.ACCESS_FINE_LOCATION",
    ],
    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [
          { scheme: "https", host: domain, pathPrefix: "/x/" },
          { scheme: "https", host: domain, pathPrefix: "/c/" },
          { scheme: "https", host: domain, pathPrefix: "/n/" },
        ],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-camera", { cameraPermission: "명함을 촬영해 연락처로 저장하고, 오프라인 교환 패스를 스캔합니다." }],
    // foreground only: no background BLE modes (교환 화면을 연 동안에만 동작)
    ["react-native-ble-plx", { isBackgroundEnabled: false, neverForLocation: true, bluetoothAlwaysPermission: "교환 화면을 연 동안 근처 LINKOS 사용자를 찾습니다." }],
  ],
  experiments: { typedRoutes: false },
  extra: { apiOrigin },
};

export default config;
