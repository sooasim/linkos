// F-182 모바일 딥링크 수신: /x/{token}, /c/{code} opened in the installed app.
// Exchange before signup: the card shows without login; a signed-in user replies with their own card (mutual),
// a signed-out user replies with a short manual form and can claim afterwards (Claim은 교환 뒤).
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Switch, Text, View } from "react-native";
import { ApiError, PENDING_CLAIM_KEY, api } from "./api";
import { useAuth } from "./auth";
import { Button, Display, ErrorText, Eyebrow, Field, Muted, Screen, color } from "./ui";

interface Landing {
  acceptsReply: boolean;
  placeLabel: string | null;
  sender: { name: string; company: string | null; jobTitle: string | null; headline: string | null; fields: { type: string; value: string }[] };
}

export function ReceiveCard({ tokenOrCode }: { tokenOrCode: string }) {
  const router = useRouter();
  const { me } = useAuth();
  const [landing, setLanding] = useState<Landing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ fullName: "", company: "", email: "", phone: "" });
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ claim: boolean } | null>(null);

  useEffect(() => {
    api<Landing>(`/exchange/sessions/${encodeURIComponent(tokenOrCode)}`, { auth: !!me })
      .then(setLanding)
      .catch((e) => setError(e instanceof ApiError && e.status === 410 ? e.message : "교환 링크를 열 수 없어요. 상대에게 새 링크를 요청하세요."));
  }, [tokenOrCode, me]);

  const replyWithMyCard = async () => {
    if (!me?.profile) return;
    setBusy(true);
    setError(null);
    try {
      const p = await api<{ name: string; company: string | null; jobTitle: string | null; fields: { type: string; value: string; visibility: string }[] }>(`/profiles/${me.profile.id}`);
      // share only business-or-wider fields, never private/trusted ones
      const pick = (t: string[]) => p.fields.find((f) => t.includes(f.type) && (f.visibility === "public" || f.visibility === "business"))?.value ?? null;
      const card = { fullName: p.name, company: p.company, jobTitle: p.jobTitle, email: pick(["email"]), phone: pick(["mobile", "phone"]), website: pick(["website"]) };
      const sharedFields = (Object.keys(card) as (keyof typeof card)[]).filter((k) => card[k]);
      await api(`/exchange/sessions/${encodeURIComponent(tokenOrCode)}/reply`, { body: { card, sharedFields, consent: { exchange: true }, provenance: {} } });
      setDone({ claim: false });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const replyAsGuest = async () => {
    setBusy(true);
    setError(null);
    try {
      const card = { fullName: form.fullName.trim(), company: form.company.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null };
      const sharedFields = (Object.keys(card) as (keyof typeof card)[]).filter((k) => card[k]);
      const r = await api<{ claimToken: string | null }>(`/exchange/sessions/${encodeURIComponent(tokenOrCode)}/reply`, { auth: false, body: { card, sharedFields, consent: { exchange: true }, provenance: {} } });
      if (r.claimToken) await AsyncStorage.setItem(PENDING_CLAIM_KEY, r.claimToken);
      setDone({ claim: !!r.claimToken });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen>
        <Eyebrow>교환 완료</Eyebrow>
        <Display size={48}>{landing?.sender.name}님께 보냈어요</Display>
        {done.claim ? (
          <>
            <Muted>가입하면 {landing?.sender.name}님 명함이 내 인맥에 저장되고, 방금 입력한 정보로 내 카드가 만들어져요. (선택)</Muted>
            <Button title="내 카드 소유하기" onPress={() => router.replace("/login")} />
          </>
        ) : (
          <Button title="인맥에서 보기" onPress={() => router.replace("/contacts")} />
        )}
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 60 }} keyboardShouldPersistTaps="handled">
        <Eyebrow>{landing?.placeLabel ? `${landing.placeLabel}에서 · ` : ""}명함이 도착했어요</Eyebrow>
        {error && <ErrorText>{error}</ErrorText>}
        {landing && (
          <>
            <View style={{ backgroundColor: color.paper, borderRadius: 28, padding: 24, marginTop: 14 }} accessible accessibilityLabel={`${landing.sender.name} 명함`}>
              <Text style={{ color: color.ink, fontSize: 13, fontWeight: "600" }}>{landing.sender.company ?? ""}</Text>
              <Text style={{ color: color.ink, fontSize: 38, fontStyle: "italic", fontFamily: "serif", marginTop: 14 }}>{landing.sender.name}</Text>
              {landing.sender.jobTitle ? <Text style={{ color: color.ink, fontSize: 16 }}>{landing.sender.jobTitle}</Text> : null}
              {landing.sender.fields.map((f) => (
                <Text key={`${f.type}:${f.value}`} style={{ color: "#3a3833", fontSize: 15, marginTop: 6 }} selectable>
                  {f.value}
                </Text>
              ))}
            </View>
            {!landing.acceptsReply ? (
              <Muted>이 링크로는 이미 교환이 완료되었어요.</Muted>
            ) : me?.profile ? (
              <Button title="내 카드로 교환" onPress={replyWithMyCard} busy={busy} />
            ) : (
              <View>
                <Muted>가입 없이 내 연락처를 보낼 수 있어요. 입력한 항목만 전달됩니다.</Muted>
                <Field label="이름 (필수)" value={form.fullName} onChangeText={(t) => setForm({ ...form, fullName: t })} />
                <Field label="회사" value={form.company} onChangeText={(t) => setForm({ ...form, company: t })} />
                <Field label="이메일" value={form.email} onChangeText={(t) => setForm({ ...form, email: t })} keyboardType="email-address" autoCapitalize="none" />
                <Field label="전화" value={form.phone} onChangeText={(t) => setForm({ ...form, phone: t })} keyboardType="phone-pad" />
                <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 14 }}>
                  <Switch value={consent} onValueChange={setConsent} accessibilityLabel="전송 동의" />
                  <Text style={{ color: color.fg, flex: 1, fontSize: 14 }}>입력한 항목을 {landing.sender.name}님에게 보내는 데 동의합니다.</Text>
                </View>
                <Button title={`${landing.sender.name}님께 보내기`} onPress={replyAsGuest} disabled={!consent || !form.fullName.trim()} busy={busy} />
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
