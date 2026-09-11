import crypto from 'crypto';

// CRX₃ packing, vendored rather than taken as a dependency: this repository
// ships no runtime dependency for release tooling, and the format is a fixed
// four-field protobuf whose wire layout is specified inline in Chromium's
// components/crx_file/crx3.proto. The quoted contract from that file is:
//
//   [4 octets] "Cr24"
//   [4 octets] format version, little-endian (3)
//   [4 octets] N, little-endian, length of the header section
//   [N octets] a binary-encoded CrxFileHeader
//   [M octets] the ZIP archive
//
// and every proof in the header signs
//   "CRX3 SignedData\x00" + signed_header_size + signed_header_data + archive
// with signed_header_size as 4 little-endian octets.
const MAGIC = Buffer.from('Cr24', 'utf8');
const FORMAT_VERSION = 3;
const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'utf8');
const CRX_ID_SIZE = 16;

function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining)
      byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function lengthDelimited(fieldNumber, payload) {
  return Buffer.concat([varint((fieldNumber << 3) | 2), varint(payload.length), payload]);
}

function uint32LE(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

export function publicKeyDer(privateKeyPem) {
  return crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' });
}

export function crxIdFromPublicKey(publicKeyDerBytes) {
  return crypto.createHash('sha256').update(publicKeyDerBytes).digest().subarray(0, CRX_ID_SIZE);
}

export function extensionIdFromCrxId(crxId) {
  const alphabet = 'abcdefghijklmnop';
  return [...crxId].map(byte => alphabet[byte >> 4] + alphabet[byte & 15]).join('');
}

// RSASSA-PKCS1-v1_5 is deterministic, so the same key over the same archive
// packs byte-identical CRX files. The reproducibility gate depends on that.
export function packCrx({ archive, privateKeyPem }) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'rsa')
    throw new Error('The CRX signing key must be an RSA private key.');
  const publicKey = publicKeyDer(privateKeyPem);
  const signedHeaderData = lengthDelimited(1, crxIdFromPublicKey(publicKey));

  const signature = crypto.createSign('sha256')
      .update(SIGNATURE_CONTEXT)
      .update(uint32LE(signedHeaderData.length))
      .update(signedHeaderData)
      .update(archive)
      .sign(privateKey);

  const proof = Buffer.concat([lengthDelimited(1, publicKey), lengthDelimited(2, signature)]);
  const header = Buffer.concat([
    lengthDelimited(2, proof),
    lengthDelimited(10000, signedHeaderData),
  ]);
  return Buffer.concat([MAGIC, uint32LE(FORMAT_VERSION), uint32LE(header.length), header, archive]);
}

// Omaha update manifest. Chrome polls the URL an external-extension entry
// names, compares `version` against the installed manifest version, and
// downloads `codebase` when it is newer.
export function updateManifest({ appId, codebase, version }) {
  const escape = value => value.replace(/[&<>"]/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[character]));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">',
    `  <app appid="${escape(appId)}">`,
    `    <updatecheck codebase="${escape(codebase)}" version="${escape(version)}" />`,
    '  </app>',
    '</gupdate>',
    '',
  ].join('\n');
}
