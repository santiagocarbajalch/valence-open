import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Verification builds set NEXT_DIST_DIR to a scratch dir so the smoke suite
  // can build + serve WITHOUT touching the .next the live service is serving
  // (single-deployer rule: a concurrent build clobbers .next mid-serve).
  // Unset (the default, and what the live service uses) → normal ".next".
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
