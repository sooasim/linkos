// Adaptive Handoff (native): same ladder as the web, with native capabilities.
//   online : 앱↔앱 BLE 근접(F-039/F-040) → OS 공유 시트 → NFC 액세서리 → 단축코드 → QR(최종 폴백)
//   offline: 서명 영수증(F-052) → QR
// QR is never the first screen; every rung auto-advances after its timeout (F-048) and attempts are reported.
import { CHANNEL_LABEL_KO, CHANNEL_TIMEOUT_MS, type Channel, DEFAULT_CAPABILITIES, planChannels } from "@linkos/domain";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { OfflineStep } from "@/OfflineStep";
import { ProximityStep } from "@/ProximityStep";
import { api, newIdempotencyKey } from "@/api";
import { useAuth } from "@/auth";
import { bleAvailable, requestBlePermissions } from "@/ble";
import { isOnline } from "@/offline";
import { Button, Chip, Display, ErrorText, Eyebrow, Muted, Screen, Surface, color } from "@/ui";

interface Session {
  sessionId: string;
  token: string;
  url: string;
  shortCode: string | null;
  shortUrl: string | null;
  channelPlan: Channel[];
}
interface Status {
  state: string;
  received: { contactId: string; fullName: string; company: string | null }[];
}

const DONE = new Set(["EXCHANGED", "CLAIM_PENDING", "CLAIMED", "SYNCED"]);

export default function Exchange() {
  const { me } = useAuth();
  const [phase, setPhase] = useState<"idle" | "starting" | "online" | "offline" | "done">("idle");
  const [session, setSession] = useState<Session | null>(null);
  const [plan, setPlan] = useState<Channel[]>([]);
  const [channel, setChannel] = useState<Channel | null>(null);
  const [deadline, setDeadline] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [doneWith, setDoneWith] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef(Date.now());

  const reset = useCallback(() => {
    setSession(null);
    setChannel(null);
    setPlan([]);
    setDoneWith(null);
    setPhase("idle");
  }, []);

  // leaving the tab stops BLE (ProximityStep unmounts) and closes an unused session
  useFocusEffect(
    useCallback(() => {
      return () => {
        setSession((s) => {
          if (s) void api(`/exchange/manage/${s.sessionId}`, { method: "DELETE" }).catch(() => undefined);
          return null;
        });
        setPhase((p) => (p === "done" ? p : "idle"));
      };
    }, []),
  );

  const start = async () => {
    setError(null);
    setPhase("starting");
    if (!(await isOnline())) {
      const p = planChannels({ ...DEFAULT_CAPABILITIES, installedApp: true, nativeBle: true, online: false });
      setPlan(p);
      setChannel(p[0] ?? "qr");
      setPhase("offline");
      return;
    }
    const ble = (await requestBlePermissions()) && (await bleAvailable());
    try {
      const s = await api<Session>("/exchange/sessions", {
        idempotencyKey: newIdempotencyKey(),
        body: {
          capabilities: { installedApp: true, nativeBle: ble, receiverMode: ble ? "nearby_app" : "unknown", webShare: true, camera: true, online: true },
          group: false,
          context: {},
        },
      });
      setSession(s);
      setPlan(s.channelPlan);
      setChannel(s.channelPlan[0] ?? "qr");
      startedAt.current = Date.now();
      setPhase("online");
    } catch (e) {
      setError((e as Error).message);
      setPhase("idle");
    }
  };

  const advance = useCallback(
    async (outcome: "failed" | "cancelled" | "timeout" | "unsupported", reason?: string) => {
      if (!channel) return;
      const idx = plan.indexOf(channel);
      let next: Channel = plan[idx + 1] ?? "qr";
      if (session) {
        const r = await api<{ nextChannel: Channel | null }>(`/exchange/manage/${session.sessionId}/attempts`, {
          body: { channel, outcome, latencyMs: Date.now() - startedAt.current, reason },
        }).catch(() => null);
        if (r?.nextChannel) next = r.nextChannel;
      }
      setChannel(next);
      startedAt.current = Date.now();
    },
    [channel, plan, session],
  );

  // per-rung timeout (QR never fails over)
  useEffect(() => {
    if (!channel || channel === "qr" || channel === "local_receipt" || phase !== "online") return setDeadline(null);
    setDeadline(Date.now() + CHANNEL_TIMEOUT_MS[channel]);
  }, [channel, phase]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (deadline && now > deadline) void advance("timeout");
  }, [now, deadline, advance]);

  // a nearby LINKOS phone / pending confirmation pauses the BLE rung timer
  const keepAlive = useCallback(() => setDeadline((d) => (d ? Math.max(d, Date.now() + 8000) : d)), []);

  // sender-side status (guest replied via link/code/QR, or proximity exchange landed in my session)
  useEffect(() => {
    if (!session || phase !== "online") return;
    const t = setInterval(async () => {
      try {
        const st = await api<Status>(`/exchange/manage/${session.sessionId}`);
        if (DONE.has(st.state)) {
          setDoneWith(st.received[0]?.fullName ?? "상대");
          setPhase("done");
        }
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [session, phase]);

  const onProximityExchanged = useCallback(
    (otherName: string, role: "sender" | "receiver") => {
      // as the resolver my own session was not used: close it
      if (role === "receiver" && session) void api(`/exchange/manage/${session.sessionId}`, { method: "DELETE" }).catch(() => undefined);
      setDoneWith(otherName);
      setPhase("done");
    },
    [session],
  );

  const share = async () => {
    if (!session) return;
    try {
      const r = await Share.share({ message: `${me?.profile?.name ?? ""}님이 LINKOS 명함을 보냈어요. 가입 없이 열어보고 내 명함도 보낼 수 있어요.\n${session.url}`, url: session.url });
      if (r.action === Share.sharedAction) {
        await api(`/exchange/manage/${session.sessionId}/attempts`, { body: { channel: "os_share", outcome: "success", latencyMs: Date.now() - startedAt.current } }).catch(() => undefined);
      } else await advance("cancelled");
    } catch {
      await advance("failed");
    }
  };

  if (!me?.profile) {
    return (
      <Screen>
        <Eyebrow>Exchange</Eyebrow>
        <Display>교환하려면 카드가 필요해요</Display>
        <Muted>웹에서 Living Card를 먼저 만들어 주세요.</Muted>
      </Screen>
    );
  }

  if (phase === "done") {
    return (
      <Screen>
        <Eyebrow>Exchange</Eyebrow>
        <Display size={52}>교환 완료</Display>
        <Muted>{doneWith}님과 명함을 주고받았어요. 감사 인사 초안은 후속 할 일에 있어요.</Muted>
        <Button title="다음 사람과 교환" onPress={() => { reset(); void start(); }} />
      </Screen>
    );
  }

  if (phase === "idle" || phase === "starting") {
    return (
      <Screen>
        <Eyebrow>Exchange</Eyebrow>
        <Display size={48}>한 번의 탭으로 교환</Display>
        <Muted>상대가 앱이 없어도 괜찮아요. 가입 없이 링크로 열어보고 바로 명함을 보낼 수 있어요.</Muted>
        {error && <ErrorText>{error}</ErrorText>}
        <View style={{ flex: 1 }} />
        <Button title={phase === "starting" ? "준비 중…" : "교환 시작"} onPress={start} busy={phase === "starting"} style={{ marginBottom: 20 }} />
      </Screen>
    );
  }

  const remaining = deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null;
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }}>
        <Eyebrow>Exchange</Eyebrow>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 }} accessibilityLabel="교환 채널 순서">
          {plan.map((c, i) => {
            const cur = plan.indexOf(channel ?? "qr");
            return (
              <View key={c} style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: i === cur ? color.fg : "transparent", borderWidth: 1, borderColor: color.line }}>
                <Text style={{ color: i === cur ? color.ink : color.mute, fontSize: 12, fontWeight: "600", textDecorationLine: i < cur ? "line-through" : "none" }}>{CHANNEL_LABEL_KO[c]}</Text>
              </View>
            );
          })}
        </View>

        <Surface style={{ marginTop: 16 }}>
          {phase === "offline" && channel === "local_receipt" && <OfflineStep />}
          {phase === "offline" && channel === "qr" && <Muted>오프라인에서는 링크 QR이 열리지 않아요. 연결되면 다시 시도하세요.</Muted>}

          {phase === "online" && session && channel === "ble_proximity" && <ProximityStep sessionId={session.sessionId} onActivity={keepAlive} onExchanged={onProximityExchanged} />}
          {phase === "online" && session && channel === "os_share" && (
            <View>
              <Muted>메시지·메일·AirDrop·Quick Share 등 기기가 지원하는 방법으로 1회용 링크를 보내세요.</Muted>
              <Button title="공유 시트 열기" onPress={share} />
            </View>
          )}
          {phase === "online" && channel === "nfc_accessory" && (
            <View>
              <Text style={{ color: color.fg, fontSize: 18, fontWeight: "600" }}>NFC 카드를 상대 폰 뒷면에 대세요</Text>
              <Muted>태그할 때마다 1회용 교환 링크가 새로 만들어져 상대 브라우저에서 열립니다.</Muted>
            </View>
          )}
          {phase === "online" && session && channel === "short_code" && session.shortCode && (
            <View style={{ alignItems: "center" }}>
              <Muted>상대가 브라우저에서 입력</Muted>
              <Text style={{ color: color.fg, fontSize: 15, fontWeight: "600", marginTop: 4 }}>{session.url.replace(/^https?:\/\//, "").split("/")[0]}/c</Text>
              <Text style={{ color: color.fg, fontSize: 56, letterSpacing: 8, fontWeight: "700", marginTop: 10 }} accessibilityLabel={`교환 코드 ${session.shortCode.split("").join(" ")}`}>
                {session.shortCode}
              </Text>
            </View>
          )}
          {phase === "online" && session && channel === "qr" && (
            <View style={{ alignItems: "center" }}>
              <View style={{ backgroundColor: color.paper, padding: 16, borderRadius: 24 }} accessible accessibilityLabel="교환 링크 QR 코드">
                <QRCode value={session.url} size={220} backgroundColor={color.paper} color={color.ink} />
              </View>
              <Muted>카메라로 스캔하면 바로 열립니다</Muted>
            </View>
          )}

          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 16 }}>
            {channel !== "qr" && channel !== "local_receipt" ? (
              <Text onPress={() => void advance("cancelled", "user_skip")} accessibilityRole="button" style={{ color: color.fg, fontWeight: "600" }}>
                다른 방법{remaining !== null ? ` · ${remaining}s` : ""}
              </Text>
            ) : (
              <Chip>{channel === "qr" ? "최종 폴백 · QR" : "오프라인"}</Chip>
            )}
            <Text onPress={() => { if (session) void api(`/exchange/manage/${session.sessionId}`, { method: "DELETE" }).catch(() => undefined); reset(); }} accessibilityRole="button" style={{ color: color.mute }}>
              취소
            </Text>
          </View>
        </Surface>
        {phase === "offline" && <Button title="온라인으로 다시 시도" variant="ghost" onPress={() => { reset(); void start(); }} />}
      </ScrollView>
    </Screen>
  );
}
