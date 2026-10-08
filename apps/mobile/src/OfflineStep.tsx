// F-052 오프라인 교환 (local_receipt rung): show my signed pass to the other LINKOS app, or scan theirs.
// The pass is only meaningful to the LINKOS app (it is not a web link); receipts sync automatically on reconnect.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useEffect, useRef, useState } from "react";
import { Switch, Text, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { type QueuedReceipt, isOnline, issueOfflinePass, offlineReady, pendingReceipts, receivePass, syncQueue } from "./offline";
import { Button, ErrorText, Muted, color } from "./ui";

export function OfflineStep() {
  const [mode, setMode] = useState<"menu" | "show" | "scan">("menu");
  const [pass, setPass] = useState<string | null>(null);
  const [ready, setReady] = useState<boolean | null>(null);
  const [reciprocate, setReciprocate] = useState(true);
  const [saved, setSaved] = useState<QueuedReceipt | null>(null);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [perm, requestPerm] = useCameraPermissions();
  const handled = useRef(false);

  const refresh = async () => setPending((await pendingReceipts()).length);
  useEffect(() => {
    void offlineReady().then(setReady);
    void refresh();
  }, []);

  const show = async () => {
    setError(null);
    try {
      setPass(await issueOfflinePass());
      setMode("show");
    } catch {
      setError("오프라인 교환을 쓰려면 한 번 온라인에서 로그인하고 Living Card를 만들어야 해요.");
    }
  };

  const onScanned = async (data: string) => {
    if (handled.current || !data.startsWith("LKP1.")) return;
    handled.current = true;
    try {
      setSaved(await receivePass(data, { reciprocate }));
      setMode("menu");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setMode("menu");
    } finally {
      setTimeout(() => (handled.current = false), 1500);
    }
  };

  const syncNow = async () => {
    if (!(await isOnline())) return setError("아직 오프라인이에요. 연결되면 자동으로 저장돼요.");
    const r = await syncQueue();
    await refresh();
    setError(r.rejected ? `${r.rejected}건은 검증에 실패해 저장하지 못했어요.` : null);
  };

  if (ready === false) return <Muted>오프라인 교환을 쓰려면 한 번 온라인에서 로그인하고 Living Card를 만들어야 해요.</Muted>;

  if (mode === "show" && pass) {
    return (
      <View style={{ alignItems: "center" }}>
        <Muted>상대 LINKOS 앱의 "패스 스캔"으로 읽게 하세요</Muted>
        <View style={{ backgroundColor: color.paper, padding: 16, borderRadius: 24, marginTop: 12 }} accessible accessibilityLabel="오프라인 교환 패스 코드">
          <QRCode value={pass} size={220} backgroundColor={color.paper} color={color.ink} />
        </View>
        <Muted>12시간 동안 유효한 서명 패스 · 내 이름만 담겨 있어요</Muted>
        <Button title="닫기" variant="ghost" onPress={() => setMode("menu")} />
      </View>
    );
  }

  if (mode === "scan") {
    if (!perm?.granted) {
      return (
        <View>
          <Muted>상대 패스를 읽으려면 카메라 권한이 필요해요.</Muted>
          <Button title="카메라 허용" onPress={requestPerm} />
        </View>
      );
    }
    return (
      <View style={{ height: 320, borderRadius: 24, overflow: "hidden" }}>
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={(r) => void onScanned(r.data)} accessibilityLabel="상대 패스 스캔" />
        <Button title="취소" variant="ghost" onPress={() => setMode("menu")} />
      </View>
    );
  }

  return (
    <View>
      <Text style={{ color: color.fg, fontSize: 20, fontWeight: "600" }}>오프라인이에요</Text>
      <Muted>둘 다 LINKOS 앱이 있다면 서명된 패스로 교환하고, 연결되면 자동으로 저장돼요.</Muted>
      <Button title="내 패스 보여주기" onPress={show} />
      <Button title="상대 패스 스캔" variant="ink" onPress={() => setMode("scan")} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
        <Text style={{ color: color.fg, fontSize: 15, flex: 1 }}>내 명함도 상대에게 보내기</Text>
        <Switch value={reciprocate} onValueChange={setReciprocate} accessibilityLabel="내 명함도 상대에게 보내기" />
      </View>
      {saved && <Muted>{saved.senderName}님 패스를 보관했어요. 연결되면 인맥에 저장됩니다.</Muted>}
      {pending > 0 && <Button title={`대기 중 ${pending}건 지금 동기화`} variant="ghost" onPress={syncNow} />}
      {error && <ErrorText>{error}</ErrorText>}
    </View>
  );
}
