import type { PoWChallenge, PoWResponse } from "./types.js";

const RATE = 136;
const STATE_SIZE = 200;

const RC: bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

const RHO_OFFSETS = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

function rotl64(x: bigint, n: number): bigint {
  return ((x << BigInt(n & 63)) | (x >> BigInt((64 - (n & 63)) & 63))) & 0xffffffffffffffffn;
}

function bytesToLanes(bytes: Uint8Array): bigint[] {
  const lanes = new Array<bigint>(25);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      let v = 0n;
      const off = 8 * (5 * y + x);
      for (let z = 0; z < 8; z++) {
        v |= BigInt(bytes[off + z]) << BigInt(8 * z);
      }
      lanes[x + 5 * y] = v;
    }
  }
  return lanes;
}

function lanesToBytes(lanes: bigint[]): Uint8Array {
  const bytes = new Uint8Array(STATE_SIZE);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      let v = lanes[x + 5 * y];
      const off = 8 * (5 * y + x);
      for (let z = 0; z < 8; z++) {
        bytes[off + z] = Number(v & 0xffn);
        v >>= 8n;
      }
    }
  }
  return bytes;
}

function keccakF1600(state: bigint[], startRound: number, endRound: number): void {
  for (let r = startRound; r < endRound; r++) {
    const C = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl64(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] ^= d;
      }
    }

    let x = 1;
    let y = 0;
    let current = state[x + 5 * y];
    for (let t = 0; t < 24; t++) {
      const nx = y;
      const ny = (2 * x + 3 * y) % 5;
      const tmp = state[nx + 5 * ny];
      state[nx + 5 * ny] = rotl64(current, RHO_OFFSETS[x + 5 * y]);
      current = tmp;
      x = nx;
      y = ny;
    }

    for (let y = 0; y < 5; y++) {
      const iy = 5 * y;
      const l0 = state[iy];
      const l1 = state[1 + iy];
      const l2 = state[2 + iy];
      const l3 = state[3 + iy];
      const l4 = state[4 + iy];
      state[iy] = l0 ^ (~l1 & l2);
      state[1 + iy] = l1 ^ (~l2 & l3);
      state[2 + iy] = l2 ^ (~l3 & l4);
      state[3 + iy] = l3 ^ (~l4 & l0);
      state[4 + iy] = l4 ^ (~l0 & l1);
    }

    state[0] ^= RC[r];
  }
}

export function deepSeekHashV1(input: Uint8Array): Uint8Array {
  const stateBytes = new Uint8Array(STATE_SIZE);

  const k = (RATE - ((input.length + 2) % RATE)) % RATE;
  const paddedLen = input.length + 2 + k;
  const padded = new Uint8Array(paddedLen);
  padded.set(input);
  padded[input.length] = 0x06;
  for (let i = 0; i < k; i++) {
    padded[input.length + 1 + i] = 0x00;
  }
  padded[paddedLen - 1] = 0x80;

  for (let off = 0; off < paddedLen; off += RATE) {
    for (let j = 0; j < RATE; j++) {
      stateBytes[j] ^= padded[off + j];
    }
    const lanes = bytesToLanes(stateBytes);
    keccakF1600(lanes, 1, 24);
    const newBytes = lanesToBytes(lanes);
    stateBytes.set(newBytes);
  }

  return stateBytes.slice(0, 32);
}

export function solvePoW(challenge: PoWChallenge): PoWResponse {
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const maxDigits = String(challenge.difficulty).length;
  const input = new Uint8Array(prefixBytes.length + maxDigits);
  input.set(prefixBytes);

  for (let n = 0; n <= challenge.difficulty; n++) {
    const nStr = String(n);
    const nOff = prefixBytes.length;
    for (let d = 0; d < nStr.length; d++) {
      input[nOff + d] = nStr.charCodeAt(d);
    }

    const hash = deepSeekHashV1(input.subarray(0, nOff + nStr.length));
    const hex = bytesToHex(hash);

    if (hex === challenge.challenge) {
      return {
        algorithm: challenge.algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: n,
        signature: challenge.signature,
        target_path: challenge.target_path,
      };
    }
  }

  throw new Error(`PoW solve failed: no answer found within ${challenge.difficulty} attempts`);
}

export function encodePowResponse(response: PoWResponse): string {
  const payload = JSON.stringify(response);
  return btoa(payload);
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
