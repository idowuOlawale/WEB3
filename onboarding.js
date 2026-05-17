// frontend/onboarding.js  (updated)
// ─────────────────────────────────────────────────────────────────────────────
// ONE signature from the user. That's it.
//
// What happens in that one tx:
//   ① 7702 delegation activated   (authorizationList)
//   ② addDelegate(backendWallet)  (calldata)
//   ③ ETH sent to EOA             (value field)
//
// No second popup. No second transaction.
// ─────────────────────────────────────────────────────────────────────────────

import {
  createWalletClient,
  createPublicClient,
  custom,
  http,
  encodeFunctionData,
  parseEther,
  formatEther,
} from "viem";
import { sepolia } from "viem/chains";

const DELEGATE_ABI = [
  {
    name: "addDelegate", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "delegate", type: "address" }], outputs: [],
  },
  {
    name: "delegates", type: "function", stateMutability: "view",
    inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }],
  },
];

// ── Connect wallet ────────────────────────────────────────────────────────────

export async function connectWallet() {
  if (!window.ethereum) throw new Error("Install MetaMask or Rabby first.");

  const [userAddress] = await window.ethereum.request({ method: "eth_requestAccounts" });

  // Auto-switch to Sepolia if needed
  const chainId = await window.ethereum.request({ method: "eth_chainId" });
  if (parseInt(chainId, 16) !== 11155111) {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0xaa36a7" }],
    });
  }

  const walletClient = createWalletClient({
    account:   userAddress,
    chain:     sepolia,
    transport: custom(window.ethereum),
  });

  const publicClient = createPublicClient({
    chain:     sepolia,
    transport: http(),
  });

  return { walletClient, publicClient, userAddress };
}

// ── Check if already onboarded ────────────────────────────────────────────────

export async function checkStatus(publicClient, userAddress, backendWallet) {
  try {
    const code = await publicClient.getCode({ address: userAddress });
    const has7702 = code && code.startsWith("0xef0100");
    if (!has7702) return { onboarded: false, reason: "not_delegated" };

    const isDelegate = await publicClient.readContract({
      address: userAddress, abi: DELEGATE_ABI,
      functionName: "delegates", args: [backendWallet],
    });

    return { onboarded: isDelegate, reason: isDelegate ? null : "not_delegated" };
  } catch {
    return { onboarded: false, reason: "error" };
  }
}

// ── THE main function: one signature does everything ──────────────────────────

export async function onboardUser({
  walletClient,
  publicClient,
  userAddress,
  delegateContract,
  backendWallet,
  ethToFund = parseEther("0.01"),   // how much ETH to move into the EOA
  onProgress = () => {},             // optional callback: onProgress("message")
}) {

  // ── Check already onboarded ───────────────────────────────────────────────
  const status = await checkStatus(publicClient, userAddress, backendWallet);
  if (status.onboarded) {
    onProgress("Already activated — no action needed.");
    return { alreadyOnboarded: true };
  }

  // ── Check balance ─────────────────────────────────────────────────────────
  const balance = await publicClient.getBalance({ address: userAddress });
  const needed  = ethToFund + parseEther("0.005"); // funding + gas buffer
  if (balance < needed) {
    throw new Error(
      `Need at least ${formatEther(needed)} Sepolia ETH. ` +
      `You have ${formatEther(balance)}. Get test ETH at sepoliafaucet.com`
    );
  }

  // ── Step A: Sign 7702 authorization (popup 1 — just a signature, no gas) ──
  onProgress("Step 1/2 — Sign the authorization (no gas)…");

  const authorization = await walletClient.signAuthorization({
    contractAddress: delegateContract,
  });

  // ── Step B: ONE transaction — 3 things at once ────────────────────────────
  onProgress("Step 2/2 — Confirm the transaction in MetaMask…");
  onProgress("(This installs code + whitelists backend + sends ETH in one go)");

  const hash = await walletClient.sendTransaction({
    to:   userAddress,                  // user's own EOA address
    data: encodeFunctionData({          // ← runs addDelegate() on the EOA
      abi:          DELEGATE_ABI,
      functionName: "addDelegate",
      args:         [backendWallet],
    }),
    value: ethToFund,                   // ← ETH transfer, same tx, no extra sig
    authorizationList: [authorization], // ← activates 7702 code installation
  });

  onProgress(`Transaction sent — waiting for confirmation…`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  onProgress("✅ Done! All 3 things happened in 1 transaction:");
  onProgress("   • Smart contract code installed on your wallet");
  onProgress("   • Backend whitelisted as delegate");
  onProgress(`   • ${formatEther(ethToFund)} ETH transferred`);

  // ── Tell backend the user is registered ──────────────────────────────────
  await fetch("/api/register", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ userAddress, txHash: hash }),
  });

  return { hash, receipt, alreadyOnboarded: false };
}

// ── Revoke ────────────────────────────────────────────────────────────────────

export async function revokeAccess(walletClient, publicClient, userAddress) {
  // Point 7702 delegation at zero address — clears it completely
  const authorization = await walletClient.signAuthorization({
    contractAddress: "0x0000000000000000000000000000000000000000",
  });

  const hash = await walletClient.sendTransaction({
    authorizationList: [authorization],
    to:   userAddress,
    data: "0x",
  });

  await publicClient.waitForTransactionReceipt({ hash });

  await fetch("/api/deregister", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ userAddress }),
  });

  return { hash };
}
