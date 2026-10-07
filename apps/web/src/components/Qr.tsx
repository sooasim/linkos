"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

export function Qr({ value, size = 240 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState<string>("");
  useEffect(() => {
    QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0e0e10", light: "#ffffff" } }).then(setSvg);
  }, [value]);
  return <div role="img" aria-label="교환 QR 코드" className="overflow-hidden rounded-2xl bg-white p-3" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}
