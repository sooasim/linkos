import { Tabs } from "expo-router";
import { type ColorValue, Text } from "react-native";
import { color } from "@/ui";

const glyph = (g: string) =>
  function TabIcon({ color: c }: { color: ColorValue }) {
    return (
      <Text style={{ color: c, fontSize: 18 }} accessibilityElementsHidden importantForAccessibility="no">
        {g}
      </Text>
    );
  };

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: color.ink, borderTopColor: color.line },
        tabBarActiveTintColor: color.signal,
        tabBarInactiveTintColor: color.mute,
        sceneStyle: { backgroundColor: color.ink },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "내 카드", tabBarIcon: glyph("◐"), tabBarAccessibilityLabel: "내 카드" }} />
      <Tabs.Screen name="exchange" options={{ title: "교환", tabBarIcon: glyph("⇄"), tabBarAccessibilityLabel: "교환" }} />
      <Tabs.Screen name="scan" options={{ title: "스캔", tabBarIcon: glyph("▣"), tabBarAccessibilityLabel: "명함 스캔" }} />
      <Tabs.Screen name="contacts" options={{ title: "인맥", tabBarIcon: glyph("☰"), tabBarAccessibilityLabel: "인맥" }} />
    </Tabs>
  );
}
