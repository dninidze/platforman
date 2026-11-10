import montserratUrl from './assets/montserrat-latin.woff2';

/**
 * CHANGES_11 N1: Montserrat is registered from its embedded bytes (FontFace + ArrayBuffer) instead of a CSS
 * data: URL, so it also loads where a page's security policy blocks data: fonts (the Artifact viewer).
 */
export function loadGameFont(): void {
  try {
    const b64 = montserratUrl.slice(montserratUrl.indexOf(',') + 1);
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const face = new FontFace('Montserrat', bytes.buffer, { weight: '100 900', style: 'normal', display: 'swap' });
    document.fonts.add(face);
    void face.load();
  } catch {
    /* fall back to the system font stack */
  }
}
