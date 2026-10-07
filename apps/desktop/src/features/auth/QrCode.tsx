import { useMemo } from 'react';
import { encode } from 'uqr';
import styles from './auth.module.css';

/**
 * A QR code drawn as one SVG path (no image file, nothing loaded from outside). Colours come
 * from the QR tokens, so it stays dark on light in both themes. `uqr` leaves JavaScript's
 * built-in objects alone, so the Windows app can keep them frozen (tauri.conf.json).
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { data } = encode(text, { ecc: 'M', border: 2 });
    const parts: string[] = [];
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) parts.push(`M${x} ${y}h1v1h-1z`);
      }),
    );
    return { size: data.length, path: parts.join('') };
  }, [text]);
  return (
    <svg
      className={styles.qr}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width={size} height={size} />
      <path d={path} />
    </svg>
  );
}
