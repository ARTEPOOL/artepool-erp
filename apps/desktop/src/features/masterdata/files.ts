/** Files in and out of the screens: Excel templates, exports and uploads travel as base64. */
import type { FilePayload } from '@artepool/shared/contracts';

/** Saves a file the server sent (an Excel template or export) through the browser's download. */
export function downloadFile(file: FilePayload): void {
  const bytes = Uint8Array.from(atob(file.dataBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A chosen file as base64 (without the `data:` prefix). */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
