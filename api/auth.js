// pages/api/auth.js
import jwt from "jsonwebtoken";
import { ethers } from "ethers";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight requests
  if (method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const {
      walletAddress,
      signature,
      message,
      baseSessionToken // optional, used by your frontend
    } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // ✅ SIGNATURE VERIFICATION
    try {
      console.log("🔐 Incoming auth request");
      console.log("walletAddress:", walletAddress);
      console.log("message:", message);
      console.log("signature:", signature);

      let recoveredAddress;

      // 🔹 Attempt standard verification
      try {
        recoveredAddress = ethers.utils.verifyMessage(message, signature);
        console.log("✅ verifyMessage recovered:", recoveredAddress);
      } catch (err) {
        console.warn("⚠️ verifyMessage failed:", err.message);

        // 🔹 Check for embedded WebAuthn JSON
        if (typeof signature === "string" && signature.startsWith("0x")) {
          const sigWithout0x = signature.slice(2);
          const buf = Buffer.from(sigWithout0x, "hex");

          const jsonStartIndex = buf.indexOf("{".charCodeAt(0));
          const jsonEndIndex = buf.lastIndexOf("}".charCodeAt(0)) + 1;

          if (jsonStartIndex !== -1 && jsonEndIndex > jsonStartIndex) {
            try {
              const jsonSlice = buf.slice(jsonStartIndex, jsonEndIndex).toString("utf8");
              const parsed = JSON.parse(jsonSlice);

              const embeddedSig = parsed.signature || parsed.response?.signature;
              if (!embeddedSig) throw new Error("No valid embedded signature found");

              recoveredAddress = ethers.utils.verifyMessage(message, embeddedSig);
              console.log("✅ WebAuthn extracted signature verified:", recoveredAddress);
            } catch (jsonErr) {
              console.error("❌ Failed to parse WebAuthn JSON:", jsonErr.message);
              throw err; // fallback to outer catch
            }
          } else {
            // 🔹 Fallback to eth_sign style hash recovery
            const msgHash = ethers.utils.hashMessage(message);
            recoveredAddress = ethers.utils.recoverAddress(msgHash, signature);
            console.log("✅ recoverAddress fallback recovered:", recoveredAddress);
          }
        } else {
          throw err;
        }
      }

      if (!recoveredAddress || recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
        console.error("❌ Signature mismatch");
        console.error("Expected:", walletAddress.toLowerCase());
        console.error("Got:", recoveredAddress?.toLowerCase());
        return res.status(401).json({ error: "Invalid wallet signature" });
      }

      console.log("✅ Signature verified successfully");
    } catch (error) {
      console.error("❌ Signature verification error:", error);

      // 🔹 Coinbase v-value fallback
      try {
        let sig = ethers.utils.splitSignature(signature);
        if (sig.v < 27) sig.v += 27;
        const normalizedSignature = ethers.utils.joinSignature(sig);

        let recoveredAddress;
        try {
          recoveredAddress = ethers.utils.verifyMessage(message, normalizedSignature);
        } catch (err) {
          console.error("verifyMessage(normalizedSignature) failed:", err);
          const msgHash = ethers.utils.hashMessage(message);
          recoveredAddress = ethers.utils.recoverAddress(msgHash, normalizedSignature);
        }

        if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
          console.error("Normalized signature mismatch");
          return res.status
