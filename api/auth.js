// pages/api/auth.js
import jwt from "jsonwebtoken";
import { ethers } from "ethers";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { walletAddress, signature, message } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // ✅ Signature verification
    const recoveredAddress = ethers.utils.verifyMessage(message, signature);
    if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(401).json({ error: "Invalid wallet signature" });
    }

    // ✅ Verify staking status
    const isStaked = await verifyMorpheusStake(walletAddress);

    // ✅ Set cookie only if staked
    if (isStaked) {
      res.setHeader(
        "Set-Cookie",
        "stakeStatus=staked; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Strict"
      );
    }

    // ✅ JWT token generation
    const token = jwt.sign({ address: walletAddress }, process.env.SESSION_SECRET, {
      expiresIn: "30d"
    });

    res.status(200).json({ token, address: walletAddress });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}