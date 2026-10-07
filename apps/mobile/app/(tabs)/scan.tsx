// 명함 촬영 → 기기 내 OCR(ML Kit, 한글/라틴) → /capture/cards(결정적 파서, provenance+confidence) → 검토 → 연락처 저장.
// AI/파서는 OCR 원문에 없는 값을 만들지 않는다; 사용자가 고친 필드는 provenance=user 로 기록된다.
import TextRecognition, { TextRecognitionScript } from "@react-native-ml-kit/text-recognition";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { api, newIdempotencyKey } from "@/api";
import { Button, Display, ErrorText, Eyebrow, Muted, Screen, color } from "@/ui";

const KEYS = ["fullName", "company", "jobTitle", "department", "email", "phone", "address", "website"] as const;
type Key = (typeof KEYS)[number];
const LABEL: Record<Key, string> = { fullName: "이름", company: "회사", jobTitle: "직책", department: "부서", email: "이메일", phone: "전화", address: "주소", website: "웹사이트" };

interface CaptureJob {
  id: string;
  fields: { key: string; value: string; confidence: number; needsReview: boolean }[];
  duplicates: { contactId: string; fullName: string; company: string | null }[];
}

export default function Scan() {
  const router = useRouter();
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [step, setStep] = useState<"camera" | "review">("camera");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<CaptureJob | null>(null);
  const [values, setValues] = useState<Record<Key, string>>(Object.fromEntries(KEYS.map((k) => [k, ""])) as Record<Key, string>);
  const [ocrValues, setOcrValues] = useState<Partial<Record<Key, { value: string; confidence: number; review: boolean }>>>({});

  const capture = async () => {
    if (!cam.current) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await cam.current.takePictureAsync({ quality: 0.85, skipProcessing: false });
      const result = await TextRecognition.recognize(photo.uri, TextRecognitionScript.KOREAN);
      const lines = result.blocks.flatMap((b) => b.lines).map((l) => ({ text: l.text.slice(0, 500) })).filter((l) => l.text.trim()).slice(0, 120);
      if (!lines.length) throw new Error("글자를 찾지 못했어요. 밝은 곳에서 명함 전체가 보이게 다시 찍어 주세요.");
      const j = await api<CaptureJob>("/capture/cards", { body: { side: "front", kind: "card", engine: "mlkit", lines } });
      const next = Object.fromEntries(KEYS.map((k) => [k, ""])) as Record<Key, string>;
      const ocr: Partial<Record<Key, { value: string; confidence: number; review: boolean }>> = {};
      const sorted = [...j.fields].sort((a, b) => (a.key === "mobile" ? -1 : b.key === "mobile" ? 1 : 0));
      for (const f of sorted) {
        const k = (f.key === "mobile" ? "phone" : f.key) as Key;
        if ((KEYS as readonly string[]).includes(k) && !next[k]) {
          next[k] = f.value;
          ocr[k] = { value: f.value, confidence: f.confidence, review: f.needsReview };
        }
      }
      setJob(j);
      setValues(next);
      setOcrValues(ocr);
      setStep("review");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const provenance: Record<string, { source: string; confidence?: number }> = {};
      for (const k of KEYS) {
        if (!values[k]) continue;
        const o = ocrValues[k];
        provenance[k] = o && o.value === values[k] ? { source: "ocr", confidence: o.confidence } : { source: "user" };
      }
      await api("/contacts", {
        idempotencyKey: newIdempotencyKey(),
        body: { ...Object.fromEntries(KEYS.map((k) => [k, values[k] || null])), fullName: values.fullName, source: "scan", provenance, businessCardId: job?.id ?? null },
      });
      setStep("camera");
      setJob(null);
      router.push("/contacts");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!perm) return <Screen>{null}</Screen>;
  if (!perm.granted) {
    return (
      <Screen>
        <Eyebrow>Scan</Eyebrow>
        <Display>명함 스캔</Display>
        <Muted>명함을 찍으면 기기 안에서 글자를 인식하고, 확인 후 연락처로 저장합니다. 사진은 서버로 보내지 않아요.</Muted>
        {perm.canAskAgain ? <Button title="카메라 허용" onPress={requestPerm} /> : <ErrorText>설정에서 카메라 권한을 허용해 주세요.</ErrorText>}
      </Screen>
    );
  }

  if (step === "review") {
    return (
      <Screen>
        <ScrollView contentContainerStyle={{ paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
          <Eyebrow>Review</Eyebrow>
          <Display>틀린 것만 고치세요</Display>
          {job?.duplicates.length ? <Muted>비슷한 연락처가 있어요: {job.duplicates.map((d) => d.fullName).join(", ")}</Muted> : null}
          {KEYS.map((k) => {
            const o = ocrValues[k];
            const low = o?.review;
            return (
              <View key={k} style={{ marginTop: 12 }}>
                <Text style={{ color: low ? color.ember : color.mute, fontSize: 13, marginBottom: 6 }}>
                  {LABEL[k]}
                  {o ? ` · 인식 ${Math.round(o.confidence * 100)}%${low ? " · 확인 필요" : ""}` : ""}
                </Text>
                <TextInput
                  value={values[k]}
                  onChangeText={(t) => setValues({ ...values, [k]: t })}
                  accessibilityLabel={LABEL[k]}
                  placeholderTextColor={color.mute}
                  style={{ borderWidth: 1, borderColor: low ? color.ember : color.line, borderRadius: 16, color: color.fg, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 }}
                />
              </View>
            );
          })}
          {error && <ErrorText>{error}</ErrorText>}
          <Button title="연락처로 저장" onPress={save} disabled={!values.fullName.trim()} busy={busy} />
          <Button title="다시 찍기" variant="ghost" onPress={() => setStep("camera")} />
        </ScrollView>
      </Screen>
    );
  }

  return (
    <Screen>
      <Eyebrow>Scan</Eyebrow>
      <Display>명함 스캔</Display>
      <View style={{ flex: 1, borderRadius: 28, overflow: "hidden", marginTop: 14, marginBottom: 12 }}>
        <CameraView ref={cam} style={{ flex: 1 }} facing="back" accessibilityLabel="명함 촬영 미리보기" />
      </View>
      {error && <ErrorText>{error}</ErrorText>}
      <Button title={busy ? "인식 중…" : "촬영"} onPress={capture} busy={busy} style={{ marginBottom: 16 }} />
    </Screen>
  );
}
