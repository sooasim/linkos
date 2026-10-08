// 내 Living Card (owner view — includes my private fields, labelled by visibility)
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { api } from "@/api";
import { useAuth } from "@/auth";
import { Button, Display, ErrorText, Eyebrow, Muted, Screen, color } from "@/ui";

interface Profile {
  id: string;
  name: string;
  company: string | null;
  jobTitle: string | null;
  headline: string | null;
  bioShort: string | null;
  keywords: string[];
  fields: { id: string; type: string; label: string | null; value: string; visibility: string }[];
  offers: { text: string; confirmed: boolean }[];
  needs: { text: string; confirmed: boolean }[];
}

const VIS_LABEL: Record<string, string> = { public: "공개", business: "비즈니스", trusted: "신뢰", partner: "파트너", private: "비공개" };

export default function MyCard() {
  const { me, signOut } = useAuth();
  const router = useRouter();
  const [p, setP] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!me?.profile) return;
    setLoading(true);
    try {
      setP(await api<Profile>(`/profiles/${me.profile.id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [me?.profile]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!me?.profile) {
    return (
      <Screen>
        <Eyebrow>Living Card</Eyebrow>
        <Display>아직 카드가 없어요</Display>
        <Muted>웹에서 Living Card를 만들면 앱에서 바로 교환할 수 있어요. 명함을 스캔해 연락처를 먼저 모을 수도 있어요.</Muted>
        <Button title="명함 스캔" onPress={() => router.push("/scan")} />
        <Button title="로그아웃" variant="ghost" onPress={signOut} />
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView refreshControl={<RefreshControl refreshing={loading} onRefresh={load} tintColor={color.signal} />} contentContainerStyle={{ paddingBottom: 120 }}>
        <Eyebrow>Living Card</Eyebrow>
        <View style={{ backgroundColor: color.paper, borderRadius: 28, padding: 24, marginTop: 14 }} accessible accessibilityLabel={`${p?.name ?? me.profile.name} 명함`}>
          <Text style={{ color: color.ink, fontSize: 13, fontWeight: "600", letterSpacing: 1.2 }}>{(p?.company ?? "").toUpperCase()}</Text>
          <Text style={{ color: color.ink, fontSize: 40, fontStyle: "italic", fontFamily: "serif", marginTop: 18 }}>{p?.name ?? me.profile.name}</Text>
          {p?.jobTitle ? <Text style={{ color: color.ink, fontSize: 16, marginTop: 4 }}>{p.jobTitle}</Text> : null}
          {p?.headline ? <Text style={{ color: "#3a3833", fontSize: 15, marginTop: 14 }}>{p.headline}</Text> : null}
          <View style={{ height: 4, width: 48, backgroundColor: color.signal, borderRadius: 2, marginTop: 18 }} />
        </View>
        {p?.fields.map((f) => (
          <View key={f.id} style={{ flexDirection: "row", justifyContent: "space-between", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: color.line }}>
            <Text style={{ color: color.fg, fontSize: 16, flex: 1 }} selectable>
              {f.value}
            </Text>
            <Text style={{ color: color.mute, fontSize: 12 }}>{VIS_LABEL[f.visibility] ?? f.visibility}</Text>
          </View>
        ))}
        {p && p.offers.some((o) => o.confirmed) && <Muted>Offer · {p.offers.filter((o) => o.confirmed).map((o) => o.text).join(", ")}</Muted>}
        {p && p.needs.some((n) => n.confirmed) && <Muted>Need · {p.needs.filter((n) => n.confirmed).map((n) => n.text).join(", ")}</Muted>}
        {error && <ErrorText>{error}</ErrorText>}
        <Button title="교환하기" onPress={() => router.push("/exchange")} />
        <Button title="로그아웃" variant="ghost" onPress={signOut} />
      </ScrollView>
    </Screen>
  );
}
