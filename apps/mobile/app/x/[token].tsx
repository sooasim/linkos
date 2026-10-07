import { useLocalSearchParams } from "expo-router";
import { ReceiveCard } from "@/ReceiveCard";

// Universal Link / App Link: https://<domain>/x/{token}
export default function ExchangeLink() {
  const { token } = useLocalSearchParams<{ token: string }>();
  return <ReceiveCard tokenOrCode={String(token ?? "")} />;
}
