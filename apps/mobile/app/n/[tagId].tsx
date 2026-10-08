// Universal Link / App Link for an NFC accessory tag: https://<domain>/n/{tagId}
// The server mints a fresh one-time exchange session per tap and answers with a redirect to /x/{token}.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { API_ORIGIN, APP_USER_AGENT } from "@/config";
import { ErrorText, Eyebrow, Muted, Screen } from "@/ui";

export default function NfcTagLink() {
  const { tagId } = useLocalSearchParams<{ tagId: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_ORIGIN}/n/${encodeURIComponent(String(tagId ?? ""))}`, { redirect: "manual", headers: { "user-agent": APP_USER_AGENT } });
        // RN follows redirects natively on some platforms; accept either the Location header or the final URL
        const loc = res.headers.get("location") ?? res.url;
        const m = /\/x\/([A-Za-z0-9_-]{22,128})/.exec(loc ?? "");
        if (m?.[1]) router.replace(`/x/${m[1]}`);
        else setError(res.status === 410 ? "이 NFC 태그는 소유자가 비활성화했습니다." : "태그를 열 수 없어요.");
      } catch {
        setError("네트워크에 연결할 수 없어요.");
      }
    })();
  }, [tagId, router]);

  return (
    <Screen>
      <Eyebrow>NFC</Eyebrow>
      {error ? <ErrorText>{error}</ErrorText> : <Muted>명함을 여는 중…</Muted>}
    </Screen>
  );
}
