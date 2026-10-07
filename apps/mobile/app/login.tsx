// 이메일 OTP 로그인 (비밀번호 없음) → bearer 세션 토큰을 OS secure store 에 저장.
// 새 사용자는 필수 동의(약관/개인정보/만 14세)를 분리 기록한다(F-009). 게스트로 교환했다면 로그인 직후 Claim(F-003).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { ApiError, PENDING_CLAIM_KEY, api } from "@/api";
import { useAuth } from "@/auth";
import { Button, Display, ErrorText, Eyebrow, Field, Muted, Screen, color } from "@/ui";

const REQUIRED = [
  { type: "terms", label: "서비스 이용약관 동의" },
  { type: "privacy", label: "개인정보 수집·이용 동의" },
  { type: "age_14", label: "만 14세 이상입니다" },
] as const;

export default function Login() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<"email" | "code" | "consent">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [marketing, setMarketing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allRequired = REQUIRED.every((r) => checks[r.type]);

  const requestCode = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ devCode?: string }>("/auth/otp", { body: { email }, auth: false });
      setDevCode(r.devCode ?? null);
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verify = async (withConsents: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const consents = withConsents ? [...REQUIRED.map((r) => ({ type: r.type, granted: true })), { type: "marketing", granted: marketing }] : [];
      const r = await api<{ sessionToken: string }>("/auth/token", { body: { email, code, consents }, auth: false });
      await signIn(r.sessionToken);
      // Claim after exchange (F-003): a guest reply made in this app before signing in
      const claim = await AsyncStorage.getItem(PENDING_CLAIM_KEY);
      if (claim) {
        await api("/guest/claim", { body: { claimToken: claim } }).catch(() => undefined);
        await AsyncStorage.removeItem(PENDING_CLAIM_KEY);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "consent_required") setStep("consent");
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Eyebrow>LINKOS</Eyebrow>
          {step === "email" && (
            <View>
              <Display size={52}>시작하기.</Display>
              <Muted>이메일로 받은 6자리 코드로 로그인합니다.</Muted>
              <Field label="이메일" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" placeholder="you@company.com" />
              <Button title={busy ? "보내는 중…" : "코드 받기"} onPress={requestCode} disabled={!email.includes("@")} busy={busy} />
            </View>
          )}
          {step === "code" && (
            <View>
              <Pressable onPress={() => setStep("email")} accessibilityRole="button" accessibilityLabel="이메일 다시 입력">
                <Muted>← {email}</Muted>
              </Pressable>
              <Display size={52}>코드 입력</Display>
              <Muted>메일함을 확인하세요. 10분간 유효합니다.</Muted>
              {devCode && <Muted>개발 모드(메일 미설정): 코드 {devCode}</Muted>}
              <Field
                label="6자리 코드"
                value={code}
                onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
                keyboardType="number-pad"
                autoComplete="one-time-code"
                textContentType="oneTimeCode"
                style={{ fontSize: 30, letterSpacing: 10, textAlign: "center" }}
              />
              <Button title={busy ? "확인 중…" : "로그인"} onPress={() => verify(false)} disabled={code.length !== 6} busy={busy} />
            </View>
          )}
          {step === "consent" && (
            <View>
              <Display size={44}>약관 동의</Display>
              <Muted>필수 항목과 선택 항목을 분리해 기록합니다.</Muted>
              {REQUIRED.map((r) => (
                <View key={r.type} style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
                  <Text style={{ color: color.fg, fontSize: 16, flex: 1 }}>
                    <Text style={{ color: color.ember }}>[필수] </Text>
                    {r.label}
                  </Text>
                  <Switch value={!!checks[r.type]} onValueChange={(v) => setChecks({ ...checks, [r.type]: v })} accessibilityLabel={r.label} />
                </View>
              ))}
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
                <Text style={{ color: color.fg, fontSize: 16, flex: 1 }}>
                  <Text style={{ color: color.mute }}>[선택] </Text>마케팅 정보 수신
                </Text>
                <Switch value={marketing} onValueChange={setMarketing} accessibilityLabel="마케팅 정보 수신" />
              </View>
              <Button title="동의하고 가입 완료" onPress={() => verify(true)} disabled={!allRequired} busy={busy} />
            </View>
          )}
          {error && <ErrorText>{error}</ErrorText>}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
