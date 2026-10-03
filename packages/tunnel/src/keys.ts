import * as nodeCrypto from 'node:crypto';
import {
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  timingSafeEqual,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';

import { QuerybaraError } from '@querybara/core';
import ssh2 from 'ssh2';

import { errorMessage } from './errors';
import { WireError, WireReader, mpint, wireString, wireUint32 } from './wire';

/**
 * SSH private keys (spec §4): OpenSSH and PEM keys go to ssh2 as they are; PKCS#8 and PuTTY PPK
 * (versions 2 and 3) are decoded here and handed to ssh2 as an in-memory OpenSSH key. Decrypted
 * key material never leaves the process and never appears in messages.
 */

export type PrivateKeyFormat = 'openssh' | 'pem' | 'pkcs8' | 'ppk';

/** What the UI shows about a key file, and the PPK conversion. */
export interface PrivateKeyInfo {
  readonly format: PrivateKeyFormat;
  readonly encrypted: boolean;
  /** The key is encrypted and no passphrase was given: ask for one and import again. */
  readonly needsPassphrase: boolean;
  /** e.g. ssh-ed25519, ssh-rsa, ecdsa-sha2-nistp256. Unknown for a locked PEM or PKCS#8 key. */
  readonly keyType?: string;
  /** `SHA256:…`, as `ssh-keygen -lf` prints it. Unknown for a locked PEM or PKCS#8 key. */
  readonly fingerprintSha256?: string;
  /** The authorized_keys line for the key. */
  readonly publicKey?: string;
  readonly comment?: string;
  /**
   * For a PuTTY key: the same key as PKCS#8 PEM, encrypted with the same passphrase when the PPK
   * was encrypted, which OpenSSH and Querybara both read. Save it with owner-only permissions.
   */
  readonly converted?: string;
}

type EcCurve = 'nistp256' | 'nistp384' | 'nistp521';

/** Private key components as unsigned big-endian integers or raw bytes. */
type KeyParts =
  | {
      readonly kind: 'rsa';
      readonly n: Buffer;
      readonly e: Buffer;
      readonly d: Buffer;
      readonly p: Buffer;
      readonly q: Buffer;
      readonly iqmp: Buffer;
    }
  | { readonly kind: 'ecdsa'; readonly curve: EcCurve; readonly q: Buffer; readonly d: Buffer }
  | { readonly kind: 'ed25519'; readonly publicKey: Buffer; readonly seed: Buffer };

const CURVES: Readonly<Record<EcCurve, { readonly jwk: string; readonly size: number }>> = {
  nistp256: { jwk: 'P-256', size: 32 },
  nistp384: { jwk: 'P-384', size: 48 },
  nistp521: { jwk: 'P-521', size: 66 },
};

/** A key ssh2 can parse, with the passphrase it needs (OpenSSH and PEM keys stay encrypted). */
export interface Ssh2Key {
  readonly text: string;
  readonly passphrase?: string;
}

interface Unlocked {
  readonly status: 'ok';
  readonly format: PrivateKeyFormat;
  readonly encrypted: boolean;
  readonly keyType: string;
  readonly publicBlob: Buffer;
  readonly comment: string;
  readonly ssh2Key: Ssh2Key;
  readonly parts?: KeyParts;
}

type Decoded =
  | Unlocked
  | {
      readonly status: 'locked';
      readonly format: PrivateKeyFormat;
      readonly keyType?: string;
      readonly publicBlob?: Buffer;
      readonly comment?: string;
    }
  | { readonly status: 'bad-passphrase'; readonly format: PrivateKeyFormat }
  | { readonly status: 'invalid'; readonly reason: string };

// ---------------------------------------------------------------------------------------------
// Helpers

const unsigned = (value: Buffer): Buffer => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  return value.subarray(start);
};

const leftPad = (value: Buffer, size: number): Buffer =>
  value.length >= size
    ? value.subarray(value.length - size)
    : Buffer.concat([Buffer.alloc(size - value.length), value]);

const b64url = (value: Buffer): string => value.toString('base64url');
const fromB64url = (value: string | undefined): Buffer => {
  if (value === undefined) throw new WireError('incomplete key');
  return Buffer.from(value, 'base64url');
};

function bigintOf(value: Buffer): bigint {
  return value.length === 0 ? 0n : BigInt(`0x${value.toString('hex')}`);
}

function bufferOf(value: bigint): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, 'hex');
}

/** `SHA256:` plus the unpadded base64 SHA-256 of an SSH public key blob. */
export function fingerprintOf(publicBlob: Buffer): string {
  return `SHA256:${createHash('sha256').update(publicBlob).digest('base64').replace(/=+$/, '')}`;
}

/** The key algorithm named at the start of an SSH public key blob. */
export function keyTypeOf(publicBlob: Buffer): string {
  try {
    return new WireReader(publicBlob).text();
  } catch {
    return 'unknown';
  }
}

function sshType(parts: KeyParts): string {
  switch (parts.kind) {
    case 'rsa':
      return 'ssh-rsa';
    case 'ecdsa':
      return `ecdsa-sha2-${parts.curve}`;
    case 'ed25519':
      return 'ssh-ed25519';
  }
}

function publicBlobOf(parts: KeyParts): Buffer {
  const type = wireString(sshType(parts));
  switch (parts.kind) {
    case 'rsa':
      return Buffer.concat([type, mpint(parts.e), mpint(parts.n)]);
    case 'ecdsa':
      return Buffer.concat([type, wireString(parts.curve), wireString(parts.q)]);
    case 'ed25519':
      return Buffer.concat([type, wireString(parts.publicKey)]);
  }
}

/** An unencrypted openssh-key-v1 private key, for ssh2 to parse; it never leaves memory. */
function opensshPrivateKey(parts: KeyParts, comment: string): string {
  let fields: Buffer;
  switch (parts.kind) {
    case 'rsa':
      fields = Buffer.concat(
        [parts.n, parts.e, parts.d, parts.iqmp, parts.p, parts.q].map((part) => mpint(part)),
      );
      break;
    case 'ecdsa':
      fields = Buffer.concat([wireString(parts.curve), wireString(parts.q), mpint(parts.d)]);
      break;
    case 'ed25519':
      fields = Buffer.concat([
        wireString(parts.publicKey),
        wireString(Buffer.concat([parts.seed, parts.publicKey])),
      ]);
      break;
  }
  const check = randomBytes(4);
  const body = Buffer.concat([
    check,
    check,
    wireString(sshType(parts)),
    fields,
    wireString(comment),
  ]);
  const padding = Buffer.from(Array.from({ length: (8 - (body.length % 8)) % 8 }, (_, i) => i + 1));
  const blob = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    wireString('none'),
    wireString('none'),
    wireString(Buffer.alloc(0)),
    wireUint32(1),
    wireString(publicBlobOf(parts)),
    wireString(Buffer.concat([body, padding])),
  ]);
  const lines = blob.toString('base64').match(/.{1,70}/g) ?? [];
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

function jwkOf(parts: KeyParts): JsonWebKey {
  switch (parts.kind) {
    case 'rsa': {
      const d = bigintOf(parts.d);
      const dp = d % (bigintOf(parts.p) - 1n);
      const dq = d % (bigintOf(parts.q) - 1n);
      return {
        kty: 'RSA',
        n: b64url(unsigned(parts.n)),
        e: b64url(unsigned(parts.e)),
        d: b64url(unsigned(parts.d)),
        p: b64url(unsigned(parts.p)),
        q: b64url(unsigned(parts.q)),
        dp: b64url(bufferOf(dp)),
        dq: b64url(bufferOf(dq)),
        qi: b64url(unsigned(parts.iqmp)),
      };
    }
    case 'ecdsa': {
      const { jwk, size } = CURVES[parts.curve];
      return {
        kty: 'EC',
        crv: jwk,
        x: b64url(parts.q.subarray(1, 1 + size)),
        y: b64url(parts.q.subarray(1 + size, 1 + 2 * size)),
        d: b64url(leftPad(unsigned(parts.d), size)),
      };
    }
    case 'ed25519':
      return { kty: 'OKP', crv: 'Ed25519', x: b64url(parts.publicKey), d: b64url(parts.seed) };
  }
}

function partsFromJwk(jwk: JsonWebKey): KeyParts | string {
  if (jwk.kty === 'RSA') {
    return {
      kind: 'rsa',
      n: fromB64url(jwk.n),
      e: fromB64url(jwk.e),
      d: fromB64url(jwk.d),
      p: fromB64url(jwk.p),
      q: fromB64url(jwk.q),
      iqmp: fromB64url(jwk.qi),
    };
  }
  if (jwk.kty === 'EC') {
    const curve = (Object.keys(CURVES) as EcCurve[]).find((c) => CURVES[c].jwk === jwk.crv);
    if (curve === undefined) return `the elliptic curve ${String(jwk.crv)} is not used by SSH`;
    const size = CURVES[curve].size;
    const q = Buffer.concat([
      Buffer.from([4]),
      leftPad(fromB64url(jwk.x), size),
      leftPad(fromB64url(jwk.y), size),
    ]);
    return { kind: 'ecdsa', curve, q, d: fromB64url(jwk.d) };
  }
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') {
    return { kind: 'ed25519', publicKey: fromB64url(jwk.x), seed: fromB64url(jwk.d) };
  }
  return `${String(jwk.crv ?? jwk.kty)} keys cannot be used for SSH; use Ed25519, ECDSA or RSA`;
}

function unlockedFromParts(
  format: PrivateKeyFormat,
  encrypted: boolean,
  parts: KeyParts,
  comment: string,
): Unlocked | { status: 'invalid'; reason: string } {
  const text = opensshPrivateKey(parts, comment);
  const parsed = ssh2.utils.parseKey(text);
  if (parsed instanceof Error) return { status: 'invalid', reason: parsed.message };
  return {
    status: 'ok',
    format,
    encrypted,
    keyType: sshType(parts),
    publicBlob: publicBlobOf(parts),
    comment,
    ssh2Key: { text },
    parts,
  };
}

// ---------------------------------------------------------------------------------------------
// Formats

function decodeOpenSsh(text: string, passphrase: string | undefined): Decoded {
  const match =
    /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/.exec(text);
  if (!match) return { status: 'invalid', reason: 'the key is malformed' };
  let cipher: string;
  let publicBlob: Buffer;
  try {
    const data = Buffer.from(match[1]!.replace(/\s+/g, ''), 'base64');
    if (data.subarray(0, 15).toString('latin1') !== 'openssh-key-v1\0') {
      return { status: 'invalid', reason: 'the key is not in openssh-key-v1 format' };
    }
    const reader = new WireReader(data.subarray(15));
    cipher = reader.text();
    reader.text();
    reader.string();
    if (reader.uint32() < 1) return { status: 'invalid', reason: 'the file holds no key' };
    publicBlob = Buffer.from(reader.string());
  } catch {
    return { status: 'invalid', reason: 'the key is malformed' };
  }
  const encrypted = cipher !== 'none';
  const keyType = keyTypeOf(publicBlob);
  if (encrypted && !passphrase) {
    return { status: 'locked', format: 'openssh', keyType, publicBlob };
  }
  return decodeWithSsh2('openssh', text, encrypted, encrypted ? passphrase : undefined);
}

function decodeWithSsh2(
  format: PrivateKeyFormat,
  text: string,
  encrypted: boolean,
  passphrase: string | undefined,
): Decoded {
  const parsed = ssh2.utils.parseKey(text, passphrase);
  if (parsed instanceof Error) {
    if (encrypted) return { status: 'bad-passphrase', format };
    return { status: 'invalid', reason: parsed.message };
  }
  if (!parsed.isPrivateKey()) return { status: 'invalid', reason: 'the file holds no private key' };
  const publicBlob = parsed.getPublicSSH();
  return {
    status: 'ok',
    format,
    encrypted,
    keyType: parsed.type,
    publicBlob,
    comment: parsed.comment,
    ssh2Key: passphrase !== undefined ? { text, passphrase } : { text },
  };
}

function decodePem(text: string, passphrase: string | undefined): Decoded {
  const encrypted = /Proc-Type:\s*4,ENCRYPTED/i.test(text);
  if (encrypted && !passphrase) return { status: 'locked', format: 'pem' };
  return decodeWithSsh2('pem', text, encrypted, encrypted ? passphrase : undefined);
}

function decodePkcs8(text: string, passphrase: string | undefined): Decoded {
  const encrypted = text.includes('BEGIN ENCRYPTED PRIVATE KEY');
  if (encrypted && !passphrase) return { status: 'locked', format: 'pkcs8' };
  let key: KeyObject;
  try {
    key = createPrivateKey({
      key: text,
      format: 'pem',
      ...(encrypted ? { passphrase: passphrase ?? '' } : {}),
    });
  } catch (error) {
    if (encrypted) return { status: 'bad-passphrase', format: 'pkcs8' };
    return { status: 'invalid', reason: errorMessage(error) };
  }
  let parts: KeyParts | string;
  try {
    parts = partsFromJwk(key.export({ format: 'jwk' }));
  } catch {
    parts = `${key.asymmetricKeyType ?? 'these'} keys cannot be used for SSH; use Ed25519, ECDSA or RSA`;
  }
  if (typeof parts === 'string') return { status: 'invalid', reason: parts };
  return unlockedFromParts('pkcs8', encrypted, parts, '');
}

interface PpkFile {
  readonly version: 2 | 3;
  readonly algorithm: string;
  readonly encryption: string;
  readonly comment: string;
  readonly publicBlob: Buffer;
  readonly privateBlob: Buffer;
  readonly mac: string;
  readonly fields: ReadonlyMap<string, string>;
}

function parsePpk(text: string): PpkFile | string {
  const lines = text.split(/\r?\n/);
  const header = /^PuTTY-User-Key-File-(\d+): (\S+)\s*$/.exec(lines[0] ?? '');
  if (!header) return 'the PuTTY key header is malformed';
  const version = Number(header[1]);
  if (version !== 2 && version !== 3) {
    return `PuTTY key format version ${version} is not supported (use version 2 or 3)`;
  }
  const fields = new Map<string, string>();
  const blobs = new Map<string, Buffer>();
  for (let i = 1; i < lines.length; i++) {
    const field = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[i]!);
    if (!field) continue;
    const name = field[1]!;
    const value = field[2]!;
    if (name === 'Public-Lines' || name === 'Private-Lines') {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0 || i + count >= lines.length) {
        return 'the PuTTY key is truncated';
      }
      blobs.set(name, Buffer.from(lines.slice(i + 1, i + 1 + count).join(''), 'base64'));
      i += count;
    } else {
      fields.set(name, value.trimEnd());
    }
  }
  const publicBlob = blobs.get('Public-Lines');
  const privateBlob = blobs.get('Private-Lines');
  const encryption = fields.get('Encryption');
  const mac = fields.get('Private-MAC');
  if (!publicBlob || !privateBlob || encryption === undefined || mac === undefined) {
    return 'the PuTTY key is missing required fields';
  }
  if (encryption !== 'none' && encryption !== 'aes256-cbc') {
    return `the PuTTY key encryption "${encryption}" is not supported`;
  }
  return {
    version,
    algorithm: header[2]!,
    encryption,
    comment: fields.get('Comment') ?? '',
    publicBlob,
    privateBlob,
    mac: mac.toLowerCase(),
    fields,
  };
}

type Argon2Sync = (
  algorithm: 'argon2d' | 'argon2i' | 'argon2id',
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
) => Buffer;

/** Node gained Argon2 in 24.7; older runtimes cannot open encrypted PPK v3 keys. */
const argon2Sync = (nodeCrypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync;

interface PpkKeys {
  readonly cipherKey?: Buffer;
  readonly iv?: Buffer;
  readonly macKey: Buffer;
}

function ppkKeys(ppk: PpkFile, passphrase: string): PpkKeys | string {
  const pass = Buffer.from(passphrase, 'utf8');
  if (ppk.version === 2) {
    const macKey = createHash('sha1')
      .update('putty-private-key-file-mac-key')
      .update(pass)
      .digest();
    if (ppk.encryption === 'none') return { macKey };
    const cipherKey = Buffer.concat([
      createHash('sha1').update(wireUint32(0)).update(pass).digest(),
      createHash('sha1').update(wireUint32(1)).update(pass).digest(),
    ]).subarray(0, 32);
    return { cipherKey, iv: Buffer.alloc(16), macKey };
  }
  if (ppk.encryption === 'none') return { macKey: Buffer.alloc(0) };
  const flavour = ppk.fields.get('Key-Derivation')?.toLowerCase();
  if (flavour !== 'argon2id' && flavour !== 'argon2i' && flavour !== 'argon2d') {
    return 'the PuTTY key uses an unknown key derivation';
  }
  if (!argon2Sync) {
    return 'encrypted PuTTY keys in format version 3 need Argon2, which this runtime lacks; in PuTTYgen, export the key as an OpenSSH key (Conversions menu) and use that file';
  }
  const derived = argon2Sync(flavour, {
    message: pass,
    nonce: Buffer.from(ppk.fields.get('Argon2-Salt') ?? '', 'hex'),
    parallelism: Number(ppk.fields.get('Argon2-Parallelism')),
    tagLength: 80,
    memory: Number(ppk.fields.get('Argon2-Memory')),
    passes: Number(ppk.fields.get('Argon2-Passes')),
  });
  return {
    cipherKey: derived.subarray(0, 32),
    iv: derived.subarray(32, 48),
    macKey: derived.subarray(48, 80),
  };
}

function ppkParts(algorithm: string, publicBlob: Buffer, privateBlob: Buffer): KeyParts | string {
  const pub = new WireReader(publicBlob);
  const priv = new WireReader(privateBlob);
  if (pub.text() !== algorithm) return 'the PuTTY key type does not match its public key';
  if (algorithm === 'ssh-rsa') {
    const e = unsigned(pub.string());
    const n = unsigned(pub.string());
    const d = unsigned(priv.string());
    const p = unsigned(priv.string());
    const q = unsigned(priv.string());
    const iqmp = unsigned(priv.string());
    return { kind: 'rsa', n, e, d, p, q, iqmp };
  }
  const ec = /^ecdsa-sha2-(nistp256|nistp384|nistp521)$/.exec(algorithm);
  if (ec) {
    const curve = ec[1] as EcCurve;
    if (pub.text() !== curve) return 'the PuTTY key curve does not match its type';
    return { kind: 'ecdsa', curve, q: Buffer.from(pub.string()), d: unsigned(priv.string()) };
  }
  if (algorithm === 'ssh-ed25519') {
    const publicKey = Buffer.from(pub.string());
    const seed = Buffer.from(priv.string());
    if (publicKey.length !== 32 || seed.length !== 32) return 'the Ed25519 key is malformed';
    return { kind: 'ed25519', publicKey, seed };
  }
  if (algorithm === 'ssh-dss') {
    return 'DSA keys are obsolete and refused by current SSH servers; create an Ed25519 key instead';
  }
  return `PuTTY keys of type ${algorithm} are not supported`;
}

function decodePpk(text: string, passphrase: string | undefined): Decoded {
  const ppk = parsePpk(text);
  if (typeof ppk === 'string') return { status: 'invalid', reason: ppk };
  const encrypted = ppk.encryption !== 'none';
  if (encrypted && !passphrase) {
    return {
      status: 'locked',
      format: 'ppk',
      keyType: ppk.algorithm,
      publicBlob: ppk.publicBlob,
      comment: ppk.comment,
    };
  }
  const keys = ppkKeys(ppk, encrypted ? (passphrase ?? '') : '');
  if (typeof keys === 'string') return { status: 'invalid', reason: keys };
  let privateBlob = ppk.privateBlob;
  if (keys.cipherKey && keys.iv) {
    if (privateBlob.length % 16 !== 0) return { status: 'invalid', reason: 'the key is truncated' };
    const decipher = createDecipheriv('aes-256-cbc', keys.cipherKey, keys.iv);
    decipher.setAutoPadding(false);
    privateBlob = Buffer.concat([decipher.update(privateBlob), decipher.final()]);
  }
  const mac = createHmac(ppk.version === 2 ? 'sha1' : 'sha256', keys.macKey)
    .update(
      Buffer.concat([
        wireString(ppk.algorithm),
        wireString(ppk.encryption),
        wireString(ppk.comment),
        wireString(ppk.publicBlob),
        wireString(privateBlob),
      ]),
    )
    .digest();
  const expected = Buffer.from(ppk.mac, 'hex');
  if (expected.length !== mac.length || !timingSafeEqual(expected, mac)) {
    if (encrypted) return { status: 'bad-passphrase', format: 'ppk' };
    return { status: 'invalid', reason: 'the PuTTY key failed its integrity check' };
  }
  let parts: KeyParts | string;
  try {
    parts = ppkParts(ppk.algorithm, ppk.publicBlob, privateBlob);
  } catch (error) {
    if (!(error instanceof WireError)) throw error;
    parts = 'the PuTTY key is malformed';
  }
  if (typeof parts === 'string') return { status: 'invalid', reason: parts };
  return unlockedFromParts('ppk', encrypted, parts, ppk.comment);
}

function decodePrivateKey(input: string | Buffer, passphrase: string | undefined): Decoded {
  const text = (typeof input === 'string' ? input : input.toString('utf8')).trim();
  if (text.startsWith('PuTTY-User-Key-File-')) return decodePpk(text, passphrase);
  if (text.includes('-----BEGIN OPENSSH PRIVATE KEY-----')) return decodeOpenSsh(text, passphrase);
  if (/-----BEGIN (RSA|DSA|EC) PRIVATE KEY-----/.test(text)) return decodePem(text, passphrase);
  if (/-----BEGIN (ENCRYPTED )?PRIVATE KEY-----/.test(text)) return decodePkcs8(text, passphrase);
  if (
    /^(ssh-|ecdsa-|sk-)\S+ AAAA/.test(text) ||
    /-----BEGIN (RSA )?PUBLIC KEY-----|---- BEGIN SSH2 PUBLIC KEY ----/.test(text)
  ) {
    return {
      status: 'invalid',
      reason: 'this is a public key; choose the private key file (usually the name without .pub)',
    };
  }
  return { status: 'invalid', reason: 'it is not an OpenSSH, PEM, PKCS#8 or PuTTY private key' };
}

// ---------------------------------------------------------------------------------------------
// Public API

function info(decoded: Exclude<Decoded, { status: 'bad-passphrase' | 'invalid' }>): {
  keyType?: string;
  fingerprintSha256?: string;
  publicKey?: string;
  comment?: string;
} {
  const blob = decoded.publicBlob;
  if (!blob) return {};
  const keyType = decoded.keyType ?? keyTypeOf(blob);
  const comment = decoded.comment ?? '';
  return {
    keyType,
    fingerprintSha256: fingerprintOf(blob),
    publicKey: `${keyType} ${blob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    ...(decoded.comment !== undefined ? { comment: decoded.comment } : {}),
  };
}

/**
 * Validates a private key file's text for the profile editor: its format, key type, SHA-256
 * fingerprint and whether it is encrypted. An encrypted key without a passphrase comes back with
 * `needsPassphrase` (and whatever the file shows without decrypting it); call again with the
 * passphrase. A PuTTY key also comes back `converted` to PKCS#8 PEM.
 *
 * Throws VALIDATION_FAILED when the text is not a usable private key, or when the passphrase is
 * wrong (engineCode `BAD_PASSPHRASE`, so the UI can ask again).
 */
export function importPrivateKey(text: string, passphrase?: string): PrivateKeyInfo {
  const decoded = decodePrivateKey(text, passphrase || undefined);
  switch (decoded.status) {
    case 'invalid':
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `This is not a private key Querybara can use: ${decoded.reason}`,
        hint: 'Choose an OpenSSH, PEM, PKCS#8 or PuTTY (.ppk) private key file',
      });
    case 'bad-passphrase':
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'The passphrase for this private key is wrong',
        hint: 'Enter the passphrase the key was created with',
        engineCode: 'BAD_PASSPHRASE',
      });
    case 'locked':
      return { format: decoded.format, encrypted: true, needsPassphrase: true, ...info(decoded) };
    case 'ok': {
      let converted: string | undefined;
      if (decoded.format === 'ppk' && decoded.parts) {
        const key = createPrivateKey({ key: jwkOf(decoded.parts), format: 'jwk' });
        converted = key
          .export(
            decoded.encrypted && passphrase
              ? { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase }
              : { type: 'pkcs8', format: 'pem' },
          )
          .toString();
      }
      return {
        format: decoded.format,
        encrypted: decoded.encrypted,
        needsPassphrase: false,
        ...info(decoded),
        ...(converted !== undefined ? { converted } : {}),
      };
    }
  }
}

/**
 * Turns a key file's contents into what ssh2 parses, or throws SSH_FAILED naming the key file
 * (`label`) with a fix hint: passphrase missing (engineCode PASSPHRASE_REQUIRED), passphrase wrong
 * (BAD_PASSPHRASE), or not a usable key.
 */
export function ssh2KeyFrom(
  contents: string | Buffer,
  passphrase: string | undefined,
  label: string,
): Ssh2Key {
  const decoded = decodePrivateKey(contents, passphrase || undefined);
  switch (decoded.status) {
    case 'ok':
      return decoded.ssh2Key;
    case 'locked':
      throw new QuerybaraError({
        code: 'SSH_FAILED',
        message: `The SSH private key ${label} is encrypted, and no passphrase was provided`,
        hint: 'Enter the key passphrase, or save it in the profile',
        engineCode: 'PASSPHRASE_REQUIRED',
      });
    case 'bad-passphrase':
      throw new QuerybaraError({
        code: 'SSH_FAILED',
        message: `The passphrase for the SSH private key ${label} is wrong`,
        hint: 'Re-enter the key passphrase',
        engineCode: 'BAD_PASSPHRASE',
      });
    case 'invalid':
      throw new QuerybaraError({
        code: 'SSH_FAILED',
        message: `The file ${label} is not an SSH private key Querybara can use: ${decoded.reason}`,
        hint: 'Choose an OpenSSH, PEM, PKCS#8 or PuTTY (.ppk) private key in the SSH settings',
      });
  }
}
