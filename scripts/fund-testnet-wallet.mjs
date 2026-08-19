// One-off ops script, not part of the npm workspaces or test suite.
// Requests testnet USDC on Base Sepolia from Circle's faucet for the
// throwaway signing key in .env (TOLLGATE_TESTNET_PRIVATE_KEY).
//
// Usage: node --env-file=.env scripts/fund-testnet-wallet.mjs

import { privateKeyToAccount } from "viem/accounts";

const apiKey = process.env.TOLLGATE_CIRCLE_API_KEY;
const privateKey = process.env.TOLLGATE_TESTNET_PRIVATE_KEY;

if (!apiKey) throw new Error("TOLLGATE_CIRCLE_API_KEY is not set — check .env");
if (!privateKey) throw new Error("TOLLGATE_TESTNET_PRIVATE_KEY is not set — check .env");

const account = privateKeyToAccount(privateKey);
console.log(`Requesting testnet USDC for ${account.address} on BASE-SEPOLIA...`);

const res = await fetch("https://api.circle.com/v1/faucet/drips", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    address: account.address,
    blockchain: "BASE-SEPOLIA",
    usdc: true,
    native: true,
  }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Faucet request failed: ${res.status} ${res.statusText}`);
  console.error(text);
  process.exit(1);
}

console.log("Faucet request accepted.");
if (text) console.log(text);
console.log(`Check balance: https://sepolia.basescan.org/address/${account.address}`);
