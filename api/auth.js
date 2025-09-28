
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { walletAddress, message, signature } = req.body;
  console.info("🔐 Incoming auth request");
  console.info("walletAddress:", walletAddress);
  console.info("message:", message);
  console.info("signature:", signature);

  let recoveredAddress = null;

  try {
    // Attempt normal message verification
    recoveredAddress = ethers.utils.verifyMessage(message, signature);
    console.info("✅ Standard signature verified:", recoveredAddress);
  } catch (err) {
    console.warn("⚠️ verifyMessage failed:", err.message);

    try {
      const sigWithout0x = signature.startsWith("0x") ? signature.slice(2) : signature;
      const buf = Buffer.from(sigWithout0x, "hex");

      const jsonStart = buf.indexOf("{".charCodeAt(0));
      const jsonEnd = buf.lastIndexOf("}".charCodeAt(0)) + 1;

      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const jsonSlice = buf.slice(jsonStart, jsonEnd).toString("utf8");
        const parsed = JSON.parse(jsonSlice);
        console.info("✅ WebAuthn JSON extracted:", parsed);

        // Try to extract a 65-byte signature right before the JSON blob
        const sigCandidate = buf.slice(jsonStart - 65, jsonStart);

        try {
          recoveredAddress = ethers.utils.verifyMessage(message, sigCandidate);
          console.info("✅ Extracted pre-JSON signature verified:", recoveredAddress);
        } catch (sigErr) {
          console.error("❌ Fallback pre-JSON signature verification failed:", sigErr.message);
          throw new Error("No valid embedded signature found");
        }
      } else {
        throw new Error("WebAuthn JSON not found in signature");
      }
    } catch (err2) {
      console.error("❌ Failed to parse WebAuthn JSON:", err2.message);
      return res.status(401).json({ error: "Invalid wallet signature format" });
    }
  }

  if (!recoveredAddress) {
    return res.status(401).json({ error: "Signature recovery failed" });
  }

  if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    console.warn("⚠️ Claimed address and recovered address mismatch.");
    console.warn("Claimed:", walletAddress.toLowerCase());
    console.warn("Recovered:", recoveredAddress.toLowerCase());
    // Continue anyway using recovered address
  }

  const canonicalAddress = recoveredAddress.toLowerCase();

  const signedCookie = jwt.sign(
    { staked: true, wallet: canonicalAddress },
    process.env.SESSION_SECRET,
    { expiresIn: "30d" }
  );

  res.setHeader("Set-Cookie", `session=${signedCookie}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
  return res.status(200).json({ success: true, address: canonicalAddress });
}
