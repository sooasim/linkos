// Hermes has no WebCrypto. @linkos/domain only needs crypto.getRandomValues (tokens, ephemeral ids, uuids);
// HMAC/SHA-256 for offline receipts are pure TypeScript in the domain package.
import * as ExpoCrypto from "expo-crypto";

type CryptoLike = { getRandomValues?: <T extends ArrayBufferView | null>(a: T) => T; randomUUID?: () => string };
const g = globalThis as unknown as { crypto?: CryptoLike };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = <T extends ArrayBufferView | null>(a: T): T => {
    if (a) ExpoCrypto.getRandomValues(a as unknown as Uint8Array);
    return a;
  };
}
if (!g.crypto.randomUUID) g.crypto.randomUUID = () => ExpoCrypto.randomUUID();
