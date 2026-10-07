import "../src/polyfills";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "@/auth";
import { cacheIdentity, ensureDeviceKey, startAutoSync } from "@/offline";
import { color } from "@/ui";

// Public deep-link routes work without login (교환이 가입보다 먼저): /x/{token}, /c/{code}, /n/{tagId}
const PUBLIC = new Set(["login", "x", "c", "n"]);

function Gate() {
  const { ready, me } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (!ready) return;
    const first = segments[0] ?? "";
    if (!me && !PUBLIC.has(first)) router.replace("/login");
    else if (me && first === "login") router.replace("/");
  }, [ready, me, segments, router]);

  // F-052: keep an offline-capable identity + per-device key, and flush queued receipts whenever we reconnect
  useEffect(() => {
    if (!me?.profile) return;
    void cacheIdentity({ userId: me.user.id, profileId: me.profile.id, name: me.profile.name });
    void ensureDeviceKey();
  }, [me]);
  useEffect(() => (me ? startAutoSync() : undefined), [me]);

  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.ink } }} />;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="light" />
        <Gate />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
