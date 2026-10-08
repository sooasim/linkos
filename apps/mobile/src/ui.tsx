// "Editorial Ink & Paper" — native counterparts of the web primitives (surface, btn-signal/ink/ghost, chip, field, eyebrow, display).
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, type StyleProp, StyleSheet, Text, TextInput, type TextInputProps, View, type ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export const color = {
  ink: "#0E0E10",
  paper: "#F4F1EA",
  signal: "#C8F03C",
  ember: "#FF5A1F",
  fg: "#F4F1EA",
  mute: "#A7A39A",
  line: "rgba(244,241,234,0.14)",
  surface: "#17171A",
};

export const font = {
  display: "serif", // Instrument Serif when bundled; system serif fallback
  ui: undefined as string | undefined,
};

export function Screen({ children, scroll = false }: { children: ReactNode; scroll?: boolean }) {
  return (
    <SafeAreaView style={s.screen} edges={["top", "left", "right"]}>
      <View style={[s.inner, scroll && { flex: 0 }]}>{children}</View>
    </SafeAreaView>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <Text style={s.eyebrow}>{children}</Text>;
}

export function Display({ children, size = 40 }: { children: ReactNode; size?: number }) {
  return (
    <Text style={[s.display, { fontSize: size, lineHeight: size * 1.05 }]} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <Text style={[s.muted, style as object]}>{children}</Text>;
}

export function Chip({ children }: { children: ReactNode }) {
  return (
    <View style={s.chip}>
      <Text style={s.chipText}>{children}</Text>
    </View>
  );
}

type Variant = "signal" | "ink" | "ghost";
export function Button({
  title,
  onPress,
  variant = "signal",
  disabled,
  busy,
  accessibilityLabel,
  style,
}: {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const bg = variant === "signal" ? color.signal : variant === "ink" ? color.paper : "transparent";
  const fg = variant === "ghost" ? color.fg : color.ink;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      style={({ pressed }) => [s.btn, { backgroundColor: bg, opacity: disabled ? 0.45 : pressed ? 0.85 : 1 }, variant === "ghost" && s.btnGhost, style]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[s.btnText, { color: fg }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field(props: TextInputProps & { label: string }) {
  const { label, style, ...rest } = props;
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput placeholderTextColor={color.mute} accessibilityLabel={label} style={[s.field, style]} {...rest} />
    </View>
  );
}

export function Surface({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[s.surface, style]}>{children}</View>;
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <Text accessibilityRole="alert" style={s.error}>
      {children}
    </Text>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.ink },
  inner: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  eyebrow: { color: color.mute, fontSize: 12, letterSpacing: 1.6, textTransform: "uppercase", fontWeight: "600" },
  display: { color: color.fg, fontFamily: font.display, fontStyle: "italic", marginTop: 6 },
  muted: { color: color.mute, fontSize: 15, lineHeight: 21, marginTop: 8 },
  chip: { alignSelf: "flex-start", borderRadius: 999, borderWidth: 1, borderColor: color.line, paddingHorizontal: 10, paddingVertical: 4 },
  chipText: { color: color.fg, fontSize: 12, fontWeight: "600" },
  btn: { minHeight: 54, borderRadius: 999, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, marginTop: 12 },
  btnGhost: { borderWidth: 1, borderColor: color.line },
  btnText: { fontSize: 17, fontWeight: "700" },
  label: { color: color.mute, fontSize: 13, marginBottom: 6 },
  field: { borderWidth: 1, borderColor: color.line, borderRadius: 16, color: color.fg, fontSize: 17, paddingHorizontal: 16, paddingVertical: 14 },
  surface: { backgroundColor: color.surface, borderRadius: 24, padding: 18, borderWidth: 1, borderColor: color.line },
  error: { color: "#ffb59a", fontSize: 14, marginTop: 10 },
  bottom: { position: "absolute", left: 20, right: 20, bottom: 24 },
});
