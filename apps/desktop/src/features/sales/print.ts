/**
 * A4 printing (decision 0008): the server makes the PDF, the app opens the Windows print dialog.
 * The PDF is loaded into a hidden frame and that frame's print dialog is shown; nothing prints
 * without the person choosing the printer and pressing Print. The page's security policy allows
 * frames only for `blob:` addresses, which only this app's own code can create.
 */
import type { FilePayload } from '@artepool/shared/contracts';

export function printPdf(file: FilePayload): Promise<void> {
  const bytes = Uint8Array.from(atob(file.dataBase64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.title = file.fileName;
  frame.style.position = 'fixed';
  frame.style.inlineSize = '0';
  frame.style.blockSize = '0';
  frame.style.border = '0';
  return new Promise((resolve) => {
    frame.onload = () => {
      // The PDF viewer needs a moment to lay the pages out before the dialog reads them.
      setTimeout(() => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } finally {
          // Leave the frame long enough for the dialog to read it.
          setTimeout(() => {
            frame.remove();
            URL.revokeObjectURL(url);
          }, 60_000);
          resolve();
        }
      }, 400);
    };
    frame.src = url;
    document.body.append(frame);
  });
}
