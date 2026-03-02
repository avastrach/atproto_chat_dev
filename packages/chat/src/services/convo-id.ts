import { createHash } from 'node:crypto'

// s32 alphabet: same as @atproto/common-web s32encode
// '234567abcdefghijklmnopqrstuvwxyz'
const S32_CHAR = '234567abcdefghijklmnopqrstuvwxyz'

/**
 * Encode a Uint8Array (byte buffer) to s32 (base32-sort) string.
 *
 * This is distinct from the number-based s32encode in @atproto/common-web.
 * We need to encode raw SHA-256 bytes (256 bits) into base32-sort, which
 * produces 52 characters (ceil(256/5) = 52).
 */
function s32encodeBytes(bytes: Uint8Array): string {
  let result = ''
  let buffer = 0
  let bitsInBuffer = 0

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bitsInBuffer += 8
    while (bitsInBuffer >= 5) {
      bitsInBuffer -= 5
      const index = (buffer >> bitsInBuffer) & 0x1f
      result += S32_CHAR[index]
    }
  }

  // Handle remaining bits (if any)
  if (bitsInBuffer > 0) {
    const index = (buffer << (5 - bitsInBuffer)) & 0x1f
    result += S32_CHAR[index]
  }

  return result
}

/**
 * Generate a deterministic conversation ID from member DIDs.
 *
 * Algorithm:
 * 1. Sort member DIDs case-sensitively (NO toLowerCase per errata E2)
 * 2. Join with ',' separator
 * 3. SHA-256 hash the joined string
 * 4. Encode the 32-byte hash with s32 (base32-sort)
 * 5. Result is 52 characters (256 bits / 5 bits per char = 51.2, ceil = 52)
 *
 * Per errata E2:
 * - Uses s32encode alphabet (234567abcdefghijklmnopqrstuvwxyz), NOT RFC 4648
 * - Output is 52 characters (not 24)
 * - DIDs are NOT lowercased (case-sensitive sort)
 */
export function generateConvoId(memberDids: string[]): string {
  if (memberDids.length < 1 || memberDids.length > 10) {
    throw new Error(
      `Invalid members array length: ${memberDids.length}. Must be between 1 and 10.`,
    )
  }

  // Sort case-sensitively (default JS sort is case-sensitive)
  const sorted = [...memberDids].sort()

  // Join with comma separator
  const input = sorted.join(',')

  // SHA-256 hash
  const hash = createHash('sha256').update(input).digest()

  // s32encode the raw bytes -> 52 characters
  const encoded = s32encodeBytes(hash)

  return encoded.substring(0, 52)
}
