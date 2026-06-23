/**
 * Client-side cryptographic helper executing inside the physician's browser.
 * Utilizes the native W3C Web Cryptography API for high-performance decryption.
 */

interface DecryptedKeys {
  key: CryptoKey;
  lookupHash: string;
}

/**
 * Sanitizes the manual input code, generates a SHA-256 lookup hash, 
 * and derives an AES-GCM decryption key using PBKDF2.
 */
export async function deriveKeysFromCode(shortCode: string): Promise<DecryptedKeys> {
  const sanitizedCode = shortCode.replace(/[^A-Z2-9]/gi, "").toUpperCase();
  const encoder = new TextEncoder();
  const codeBytes = encoder.encode(sanitizedCode);

  // 1. Generate SHA-256 hash for database lookup (prevents leaking raw code to server)
  const hashBuffer = await window.crypto.subtle.digest("SHA-256", codeBytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const lookupHash = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");

  // 2. Import base password key for derivation
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    codeBytes,
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  // 3. Stretch the code using PBKDF2 with 10,000 iterations to generate the AES key
  const salt = encoder.encode("medipulse-salt"); // Must match Android salt spec
  const key = await window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 10000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );

  return { key, lookupHash };
}

/**
 * Decrypts a Base64 encoded payload that was encrypted on-device.
 * Expects the payload to contain: [12-byte IV] + [Ciphertext + Auth Tag]
 */
export async function decryptPayload(
  base64Payload: string,
  cryptoKey: CryptoKey
): Promise<any> {
  // Convert Base64 string back to binary representation
  const binaryString = atob(base64Payload);
  const encryptedBytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    encryptedBytes[i] = binaryString.charCodeAt(i);
  }

  // Extract the prepended 12-byte IV
  const iv = encryptedBytes.slice(0, 12);
  const ciphertext = encryptedBytes.slice(12);

  // Decrypt the ciphertext payload using the derived key
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv,
      tagLength: 128
    },
    cryptoKey,
    ciphertext
  );

  const decodedString = new TextDecoder("utf-8").decode(decryptedBuffer);
  return JSON.parse(decodedString);
}
