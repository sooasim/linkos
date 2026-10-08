// 인맥(연락처) 목록 — Contact ≠ BusinessCard ≠ Encounter ≠ Relationship: here we list Contacts (most recent relationship first).
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Linking, Pressable, RefreshControl, Text, TextInput, View } from "react-native";
import { api } from "@/api";
import { pendingReceipts } from "@/offline";
import { Display, ErrorText, Eyebrow, Muted, Screen, color } from "@/ui";

interface Contact {
  id: string;
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}

export default function Contacts() {
  const [items, setItems] = useState<Contact[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(0);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const r = await api<{ contacts: Contact[] }>(`/contacts?limit=200${q ? `&q=${encodeURIComponent(q)}` : ""}`);
      setItems(r.contacts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
    setQueued((await pendingReceipts()).length);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(query);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [load]),
  );
  useEffect(() => {
    const t = setTimeout(() => void load(query), 250);
    return () => clearTimeout(t);
  }, [query, load]);

  return (
    <Screen>
      <Eyebrow>People</Eyebrow>
      <Display>인맥</Display>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder="이름·회사·이메일 검색"
        placeholderTextColor={color.mute}
        accessibilityLabel="인맥 검색"
        style={{ marginTop: 14, borderWidth: 1, borderColor: color.line, borderRadius: 999, color: color.fg, paddingHorizontal: 18, paddingVertical: 12, fontSize: 16 }}
      />
      {queued > 0 && <Muted>오프라인 교환 {queued}건이 연결되면 자동으로 저장돼요.</Muted>}
      {error && <ErrorText>{error}</ErrorText>}
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => load(query)} tintColor={color.signal} />}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={!loading ? <Muted>아직 인맥이 없어요. 교환하거나 명함을 스캔해 보세요.</Muted> : null}
        renderItem={({ item }) => (
          <View style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: color.line }}>
            <Text style={{ color: color.fg, fontSize: 17, fontWeight: "600" }}>{item.fullName}</Text>
            <Text style={{ color: color.mute, fontSize: 14, marginTop: 2 }}>{[item.company, item.jobTitle].filter(Boolean).join(" · ")}</Text>
            <View style={{ flexDirection: "row", gap: 16, marginTop: 6 }}>
              {item.phone ? (
                <Pressable onPress={() => Linking.openURL(`tel:${item.phone}`)} accessibilityRole="button" accessibilityLabel={`${item.fullName}에게 전화`}>
                  <Text style={{ color: color.signal, fontSize: 14 }}>전화</Text>
                </Pressable>
              ) : null}
              {item.email ? (
                <Pressable onPress={() => Linking.openURL(`mailto:${item.email}`)} accessibilityRole="button" accessibilityLabel={`${item.fullName}에게 메일`}>
                  <Text style={{ color: color.signal, fontSize: 14 }}>메일</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        )}
      />
    </Screen>
  );
}
