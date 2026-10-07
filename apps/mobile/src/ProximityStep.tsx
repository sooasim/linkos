// F-039 앱 근접 교환 + F-040 근접 확인 (foreground only).
// Both phones on the exchange screen advertise their own session's ephemeral id and scan for others.
// Tie-break so only one side resolves: the phone whose current ephemeral id is smaller resolves the peer;
// the other side receives the match via polling. Nothing is exchanged until BOTH people confirm the same 4-digit code.
import { type RssiSample, evaluateProximity } from "@linkos/domain";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { ApiError, api } from "./api";
import { advertise, startProximityScan, stopAdvertising } from "./ble";
import { Button, ErrorText, Muted, color } from "./ui";

export interface ActiveMatch {
  matchId: string;
  verifyCode: string;
  otherName: string;
  role: "sender" | "receiver";
}

interface MatchView {
  status: "pending" | "exchanged" | "rejected" | "expired";
  senderConfirmed: boolean;
  receiverConfirmed: boolean;
}

export function ProximityStep({
  sessionId,
  onActivity,
  onExchanged,
}: {
  sessionId: string;
  /** called when a nearby LINKOS phone is seen or a match is pending (pauses the ladder timeout) */
  onActivity: () => void;
  onExchanged: (otherName: string, role: "sender" | "receiver") => void;
}) {
  const samples = useRef<RssiSample[]>([]);
  const myEph = useRef<Set<string>>(new Set());
  const current = useRef<string>("");
  const [match, setMatch] = useState<ActiveMatch | null>(null);
  const matchRef = useRef<ActiveMatch | null>(null);
  const [hint, setHint] = useState<"searching" | "ambiguous" | "found">("searching");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  matchRef.current = match;

  // advertise + rotate the ephemeral id
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const rotate = async () => {
      try {
        const r = await api<{ ephemeralId: string; serviceUuid: string; rotateAfterMs: number }>(`/exchange/manage/${sessionId}/proximity`, { body: {} });
        if (stopped) return;
        myEph.current.add(r.ephemeralId);
        current.current = r.ephemeralId;
        await advertise(r.serviceUuid);
        timer = setTimeout(rotate, r.rotateAfterMs);
      } catch (e) {
        if (!stopped) setError(e instanceof ApiError ? e.message : "블루투스 광고를 시작하지 못했어요.");
      }
    };
    void rotate();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void stopAdvertising();
    };
  }, [sessionId]);

  // scan + evaluate (F-040: RSSI threshold over a time window, refuse ambiguous crowds)
  useEffect(() => {
    const stop = startProximityScan((s) => {
      if (myEph.current.has(s.ephemeralId)) return;
      samples.current.push(s);
      if (samples.current.length > 400) samples.current.splice(0, 200);
    });
    let resolving = false;
    const t = setInterval(async () => {
      const now = Date.now();
      samples.current = samples.current.filter((x) => now - x.at < 5000);
      if (samples.current.length) onActivity();
      if (matchRef.current || resolving) return;
      const ev = evaluateProximity(samples.current, now);
      setHint(ev.status === "none" ? "searching" : ev.status);
      if (ev.status !== "found") return;
      // tie-break: the smaller current ephemeral id resolves; the other side waits for the incoming match
      if (current.current && current.current > ev.candidate.ephemeralId) return;
      resolving = true;
      try {
        const r = await api<{ matchId: string; verifyCode: string; sender: { name: string } }>("/exchange/proximity/resolve", {
          body: { ephemeralId: ev.candidate.ephemeralId, rssi: Math.round(ev.candidate.medianRssi) },
        });
        setMatch({ matchId: r.matchId, verifyCode: r.verifyCode, otherName: r.sender.name, role: "receiver" });
      } catch {
        /* expired id / too far: keep scanning */
      } finally {
        resolving = false;
      }
    }, 500);
    return () => {
      clearInterval(t);
      stop();
    };
  }, [onActivity]);

  // incoming matches (someone resolved my advertisement)
  useEffect(() => {
    const t = setInterval(async () => {
      if (matchRef.current) return;
      try {
        const r = await api<{ matches: { matchId: string; verifyCode: string; receiverName: string }[] }>(`/exchange/manage/${sessionId}/proximity`);
        const m = r.matches[0];
        if (m && !matchRef.current) setMatch({ matchId: m.matchId, verifyCode: m.verifyCode, otherName: m.receiverName, role: "sender" });
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [sessionId]);

  // follow the match until both confirmed
  useEffect(() => {
    if (!match) return;
    onActivity();
    const t = setInterval(async () => {
      try {
        const v = await api<MatchView>(`/exchange/proximity/matches/${match.matchId}`);
        if (v.status === "exchanged") onExchanged(match.otherName, match.role);
        else if (v.status !== "pending") {
          setMatch(null);
          setConfirmed(false);
          setError(v.status === "rejected" ? "상대가 거절했어요." : "확인 시간이 지났어요. 다시 가까이 대 주세요.");
        }
      } catch {
        /* transient */
      }
    }, 1000);
    return () => clearInterval(t);
  }, [match, onActivity, onExchanged]);

  const decide = async (accept: boolean) => {
    if (!match) return;
    try {
      const v = await api<MatchView>(`/exchange/proximity/matches/${match.matchId}/confirm`, { body: { accept } });
      if (!accept || v.status === "rejected") {
        setMatch(null);
        setConfirmed(false);
        return;
      }
      setConfirmed(true);
      if (v.status === "exchanged") onExchanged(match.otherName, match.role);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (match) {
    return (
      <View accessibilityLiveRegion="polite">
        <Muted>두 화면의 숫자가 같은지 확인하세요</Muted>
        <Text style={{ color: color.fg, fontSize: 72, fontWeight: "700", letterSpacing: 14, textAlign: "center", marginTop: 8 }} accessibilityLabel={`확인 코드 ${match.verifyCode.split("").join(" ")}`}>
          {match.verifyCode}
        </Text>
        <Text style={{ color: color.fg, fontSize: 20, textAlign: "center", marginTop: 4 }}>{match.otherName}</Text>
        {confirmed ? (
          <Muted>상대의 확인을 기다리는 중…</Muted>
        ) : (
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="아니요" variant="ghost" onPress={() => decide(false)} style={{ flex: 1 }} />
            <Button title="같아요, 교환" onPress={() => decide(true)} style={{ flex: 1 }} />
          </View>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </View>
    );
  }
  return (
    <View accessibilityLiveRegion="polite">
      <Text style={{ color: color.fg, fontSize: 20, fontWeight: "600" }}>상대도 LINKOS 앱의 교환 화면을 열고 폰을 맞대 주세요</Text>
      <Muted>
        {hint === "ambiguous"
          ? "가까운 폰이 여러 대예요. 교환할 상대 폰에 더 가까이 대 주세요."
          : "화면이 켜져 있는 동안에만 짧은 임시 ID를 주고받아요. 이름·연락처는 블루투스로 보내지 않습니다."}
      </Muted>
      {error && <ErrorText>{error}</ErrorText>}
    </View>
  );
}
