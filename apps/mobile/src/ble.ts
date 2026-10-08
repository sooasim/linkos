// F-039 앱 근접 교환 — foreground BLE only (exchange screen open). No PII over the air: the advertisement is a single
// 128-bit service UUID that embeds a server-issued, 90-second ephemeral id (rotated every 30s).
//   scanning   : react-native-ble-plx (central)
//   advertising: react-native-ble-advertiser (peripheral; ble-plx is central-only)
// RSSI/time-window evaluation (F-040) is the pure evaluateProximity() from @linkos/domain.
import { type RssiSample, serviceUuidToEphemeralId } from "@linkos/domain";
import { PermissionsAndroid, Platform } from "react-native";
import * as BLEAdvertiser from "react-native-ble-advertiser";
import { BleManager, ScanMode, State } from "react-native-ble-plx";

let manager: BleManager | null = null;
function mgr(): BleManager {
  if (!manager) manager = new BleManager();
  return manager;
}

/** Android 12+: BLUETOOTH_SCAN/ADVERTISE/CONNECT; older Android: fine location. iOS prompts on first use. */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const P = PermissionsAndroid.PERMISSIONS;
  if (Number(Platform.Version) >= 31) {
    const r = await PermissionsAndroid.requestMultiple([P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT]);
    return Object.values(r).every((v) => v === PermissionsAndroid.RESULTS.GRANTED);
  }
  return (await PermissionsAndroid.request(P.ACCESS_FINE_LOCATION)) === PermissionsAndroid.RESULTS.GRANTED;
}

function advertiserAvailable(): boolean {
  return typeof (BLEAdvertiser as { broadcast?: unknown }).broadcast === "function";
}

/** True when the radio is on and both BLE roles are usable on this build. */
export async function bleAvailable(timeoutMs = 1500): Promise<boolean> {
  if (!advertiserAvailable()) return false;
  try {
    const st = await mgr().state();
    if (st === State.PoweredOn) return true;
    if (st === State.Unsupported || st === State.Unauthorized || st === State.PoweredOff) return false;
    return await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        sub.remove();
        resolve(false);
      }, timeoutMs);
      const sub = mgr().onStateChange((s) => {
        if (s === State.PoweredOn || s === State.PoweredOff || s === State.Unauthorized || s === State.Unsupported) {
          clearTimeout(t);
          sub.remove();
          resolve(s === State.PoweredOn);
        }
      }, true);
    });
  } catch {
    return false;
  }
}

/** Scan for LINKOS advertisers; emits RSSI samples for evaluateProximity(). Returns a stop function. */
export function startProximityScan(onSample: (s: RssiSample) => void): () => void {
  mgr().startDeviceScan(null, { allowDuplicates: true, scanMode: ScanMode.LowLatency }, (err, dev) => {
    if (err || !dev || dev.rssi == null) return;
    for (const u of dev.serviceUUIDs ?? []) {
      const eph = serviceUuidToEphemeralId(u);
      if (eph) onSample({ ephemeralId: eph, rssi: dev.rssi, at: Date.now() });
    }
  });
  return () => {
    try {
      mgr().stopDeviceScan();
    } catch {
      /* already stopped */
    }
  };
}

let advertising = false;

/** Advertise one ephemeral service UUID (non-connectable, no device name, no manufacturer data). */
export async function advertise(serviceUuid: string): Promise<void> {
  if (!advertiserAvailable()) throw new Error("ble_advertiser_unavailable");
  if (advertising) await BLEAdvertiser.stopBroadcast().catch(() => undefined);
  BLEAdvertiser.setCompanyId(0xffff); // reserved test id; required by the module, no manufacturer payload is sent
  // Android: ADVERTISE_MODE_LOW_LATENCY=2, ADVERTISE_TX_POWER_LOW=1 (keeps RSSI meaningful for "phones together")
  await BLEAdvertiser.broadcast(serviceUuid, [], { advertiseMode: 2, txPowerLevel: 1, connectable: false, includeDeviceName: false, includeTxPowerLevel: false });
  advertising = true;
}

export async function stopAdvertising(): Promise<void> {
  if (!advertising || !advertiserAvailable()) return;
  advertising = false;
  await BLEAdvertiser.stopBroadcast().catch(() => undefined);
}
