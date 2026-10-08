// 100-environment matrix, generated deterministically from Playwright's device descriptors (no randomness):
//  - 88 phone/tablet descriptors: every distinct viewport×DPR among the 136 non-desktop descriptors, in catalog order
//    (small phones 320px … large phones, tablets portrait + landscape, Android + iOS user agents)
//  - 12 desktop configurations derived from the 7 desktop descriptors at common real-world resolutions
// Each environment also gets a locale, time zone, color scheme, reduced-motion preference and a network profile.
// Everything runs in Chromium (webkit/firefox descriptors keep their viewport, DPR, touch and UA).
import { type PlaywrightTestOptions, devices } from "@playwright/test";

export type NetworkProfile = "fast" | "slow3g" | "offline-then-online";

export interface MatrixEnv {
  id: string;
  device: string;
  use: Partial<PlaywrightTestOptions> & { browserName: "chromium" };
  locale: string;
  timezoneId: string;
  colorScheme: "light" | "dark";
  reducedMotion: "reduce" | "no-preference";
  network: NetworkProfile;
  kind: "phone" | "tablet" | "desktop";
}

export const LOCALES = ["ko-KR", "en-US", "ja-JP", "zh-CN", "de-DE", "fr-FR", "es-ES", "en-GB"] as const;
export const TIMEZONES = ["Asia/Seoul", "America/Los_Angeles", "Europe/Berlin", "Asia/Tokyo", "UTC", "America/New_York", "Australia/Sydney", "Asia/Kolkata", "America/Sao_Paulo", "Pacific/Auckland", "Asia/Shanghai"] as const;

const DESKTOPS: { device: string; width: number; height: number }[] = [
  { device: "Desktop Chrome", width: 1280, height: 720 },
  { device: "Desktop Chrome", width: 1920, height: 1080 },
  { device: "Desktop Chrome", width: 1366, height: 768 },
  { device: "Desktop Chrome", width: 1536, height: 864 },
  { device: "Desktop Chrome HiDPI", width: 2560, height: 1440 },
  { device: "Desktop Edge", width: 1440, height: 900 },
  { device: "Desktop Edge HiDPI", width: 1280, height: 800 },
  { device: "Desktop Firefox", width: 1600, height: 900 },
  { device: "Desktop Firefox HiDPI", width: 1024, height: 768 },
  { device: "Desktop Safari", width: 1440, height: 900 },
  { device: "Desktop Safari", width: 1680, height: 1050 },
  { device: "Desktop Chrome", width: 1100, height: 700 },
];

/** Slow 3G as WebPageTest defines it: 400 ms RTT, 400 kbps down / 400 kbps up. */
export const SLOW_3G = { offline: false, latency: 400, downloadThroughput: (400 * 1024) / 8, uploadThroughput: (400 * 1024) / 8 };

function pickDevices(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of Object.keys(devices)) {
    if (name.startsWith("Desktop")) continue;
    const d = devices[name]!;
    const key = `${d.viewport.width}x${d.viewport.height}@${d.deviceScaleFactor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.slice(0, 88);
}

export function buildEnvironments(): MatrixEnv[] {
  const phones = pickDevices();
  const base: { device: string; use: Partial<PlaywrightTestOptions>; kind: MatrixEnv["kind"] }[] = [
    ...phones.map((device) => {
      const d = devices[device]!;
      const min = Math.min(d.viewport.width, d.viewport.height);
      return { device, use: { ...d } as Partial<PlaywrightTestOptions>, kind: (min >= 600 ? "tablet" : "phone") as MatrixEnv["kind"] };
    }),
    ...DESKTOPS.map(({ device, width, height }) => ({ device: `${device} ${width}x${height}`, use: { ...devices[device]!, viewport: { width, height } } as Partial<PlaywrightTestOptions>, kind: "desktop" as const })),
  ];
  return base.map((b, i) => {
    const locale = LOCALES[i % LOCALES.length]!;
    const timezoneId = TIMEZONES[(i * 7) % TIMEZONES.length]!;
    const colorScheme = Math.floor(i / 2) % 2 === 0 ? "light" : "dark";
    const reducedMotion = i % 3 === 0 ? "reduce" : "no-preference";
    const network: NetworkProfile = i % 5 === 4 ? "slow3g" : i % 10 === 7 ? "offline-then-online" : "fast";
    const { defaultBrowserType: _ignored, ...rest } = b.use as Partial<PlaywrightTestOptions> & { defaultBrowserType?: string };
    return {
      id: `${String(i + 1).padStart(3, "0")}-${b.device.replace(/[^A-Za-z0-9]+/g, "-").replace(/-+$/, "")}`,
      device: b.device,
      kind: b.kind,
      locale,
      timezoneId,
      colorScheme,
      reducedMotion,
      network,
      use: { ...rest, browserName: "chromium", locale, timezoneId, colorScheme, reducedMotion },
    };
  });
}
