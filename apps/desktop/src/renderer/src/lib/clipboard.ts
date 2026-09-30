/**
 * Puts text on the clipboard from a user action (a menu click). The page has no clipboard
 * permission (main refuses every permission request), so this uses the copy command, which a
 * user gesture allows, and fills the clipboard from its `copy` event.
 */
export function copyToClipboard(text: string): boolean {
  const onCopy = (event: ClipboardEvent): void => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
  };
  document.addEventListener('copy', onCopy);
  try {
    return document.execCommand('copy');
  } finally {
    document.removeEventListener('copy', onCopy);
  }
}
