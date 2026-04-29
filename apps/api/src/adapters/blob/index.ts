import type { BlobDriver } from './types';
import { makeLocalBlobDriver } from './local';
import { makeR2BlobDriver } from './r2';

// Driver selection happens at first use. R2 wins when its env vars are
// complete; otherwise we fall back to local fs. The decision is logged once
// so an operator can confirm what mode the running process is in.

let driver: BlobDriver | null = null;

export function getBlob(): BlobDriver {
  if (driver) return driver;
  const r2 = makeR2BlobDriver();
  if (r2) {
    driver = r2;
    console.log('[blob] using r2 driver');
  } else {
    driver = makeLocalBlobDriver();
    console.log('[blob] using local driver (set R2_* env to switch to Cloudflare R2)');
  }
  return driver;
}

// Test/dev hook — let tests force a driver without touching env.
export function _setBlobDriverForTest(d: BlobDriver | null): void {
  driver = d;
}

export type { BlobDriver };
