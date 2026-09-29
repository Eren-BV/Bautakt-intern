/**
 * Symmetrische Verschlüsselung für Zugangsdaten, die in der Datenbank liegen (z. B. OAuth-Tokens
 * einer Postfach-Verknüpfung). Der Schlüssel wird aus einem Server-Secret abgeleitet (SHA-256) -
 * kein Klartext-Geheimnis verlässt je den Server, und ohne den Secret ist die Zeile unlesbar.
 */

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
const unhex = (s: string) => Uint8Array.from(s.match(/.{1,2}/g) ?? [], (b) => parseInt(b, 16))

async function deriveKey(secret: string, namespace: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}:${secret}`))
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** Verschlüsselt `plaintext` mit einem aus `secret` abgeleiteten Schlüssel. Ergebnis: "iv:cipher" (hex). */
export async function encryptSecret(plaintext: string, secret: string, namespace: string): Promise<string> {
  const key = await deriveKey(secret, namespace)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext))
  return `${hex(iv.buffer)}:${hex(cipher)}`
}

/** Kehrt `encryptSecret` um. Wirft, wenn der Schlüssel nicht mehr passt oder der Wert beschädigt ist. */
export async function decryptSecret(payload: string, secret: string, namespace: string): Promise<string> {
  const [ivHex, cipherHex] = payload.split(':')
  if (!ivHex || !cipherHex) throw new Error('Ungültiger verschlüsselter Wert.')
  const key = await deriveKey(secret, namespace)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unhex(ivHex) }, key, unhex(cipherHex))
  return new TextDecoder().decode(plain)
}
