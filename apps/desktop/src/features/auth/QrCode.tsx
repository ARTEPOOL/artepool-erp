import { useMemo } from 'react';
import QRCode from 'qrcode';
import styles from './auth.module.css';

const QUIET_ZONE = 2;

/**
 * A QR code drawn as one SVG path (no image file, nothing loaded from outside). Colours come
 * from the QR tokens, so it stays dark on light in both themes.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const parts: string[] = [];
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return { size: modules.size + QUIET_ZONE * 2, path: parts.join('') };
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
