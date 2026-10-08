import { useLocalSearchParams } from "expo-router";
import { ReceiveCard } from "@/ReceiveCard";

// Universal Link / App Link: https://<domain>/c/{shortCode}
export default function ShortCodeLink() {
  const { code } = useLocalSearchParams<{ code: string }>();
  return <ReceiveCard tokenOrCode={String(code ?? "")} />;
}
