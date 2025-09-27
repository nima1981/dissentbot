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
      baseSessionToken // NEW PARAMETER
    } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(401).json({ error: "Authentication required" });
    }

    // ✅ SIGNATURE VERIFICATION (supports Coinbase Android)
    try {
      console.log("🔐 Incoming auth request");
      console.log("walletAddress:", walletAddress);
      console.log("message:", message);
      console.log("signature:", signature);

      let recoveredAddress;

      // Standard EIP-191
      try {
        recoveredAddress = ethers.utils.verifyMessage(message, signature);
        console.log("✅ verifyMessage recovered:", recoveredAddress);
      } catch (err) {
        console.warn("⚠️ verifyMessage failed:", err.message);

        // Detect WebAuthn-style signature embedded in hex
        if (typeof signature === "string" && signature.startsWith("0x")) {
          const sigWithout0x = signature.slice(2);
          const jsonStart = sigWithout0x.indexOf('{');
          const jsonEnd = sigWithout0x.lastIndexOf('}') + 1;

          if (jsonStart !== -1 && jsonEnd > jsonStart) {
            try {
              const hexJson = sigWithout0x.slice(jsonStart, jsonEnd);
              const jsonBytes = Buffer.from(hexJson, "hex").toString("utf8");
              const parsed = JSON.parse(jsonBytes);

              const embeddedSig = parsed.signature || parsed.response?.signature;
              if (!embeddedSig) throw new Error("No valid embedded signature found");

              recoveredAddress = ethers.utils.verifyMessage(message, embeddedSig);
              console.log("✅ WebAuthn extracted signature verified:", recoveredAddress);
            } catch (jsonErr) {
              console.error("❌ Failed to parse embedded WebAuthn JSON:", jsonErr.message);
              throw err;
            }
          } else {
            // Fallback: try raw hash recovery (eth_sign style)
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

      // Try handling bad v values (Coinbase quirk)
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
          console.error("Normalized signature does not match");
          return res.status(401).json({ error: "Invalid wallet signature" });
        }

        console.log("✅ Signature verified via normalizedSignature fallback");
      } catch (e) {
        console.error("Invalid signature format fallback failed:", e.message);
        return res.status(401).json({ error: "Invalid signature format" });
      }
    }

    // ✅ Verify staking status
    const isStaked = await verifyMorpheusStake(walletAddress);

    if (isStaked) {
      const signedCookie = jwt.sign(
        { staked: true, wallet: walletAddress.toLowerCase() },
        process.env.SESSION_SECRET,
        { expiresIn: "30d" }
      );

      res.setHeader(
        "Set-Cookie",
        `isStaked=${signedCookie}; Max-Age=2592000; Path=/; Secure; SameSite=None; Domain=.dissentbot.com`
      );
    }

    // ✅ JWT token generation
    const token = jwt.sign({ address: walletAddress }, process.env.SESSION_SECRET, {
      expiresIn: "30d"
    });

    res.status(200).json({ token, address: walletAddress });
  } catch (error) {
    console.error("Auth error:", error);
    res.status(500).json({ error: error.message });
  }
}

// ✅ Verify Morpheus Stake
async function verifyMorpheusStake(address) {
  try {
    const options = {
      method: 'GET',
      headers: {
        'X-DUNE-API-KEY': process.env.DUNE_API_KEY
      }
    };

    const queryParams = new URLSearchParams({
      filters: "subnet_id = " + process.env.SUBNET_ID + " AND wallet_address = " + address.toLowerCase(),
      columns: "net_staked_tokens"
    });

    const url = `https://api.dune.com/api/v1/query/5112115/results?${queryParams}`;
    const response = await fetch(url, options);

    if (!response.ok) {
      throw new Error('Dune API query failed.');
    }

    const data = await response.json();
    console.log("Dune data result length:", data.result?.rows?.length || 0);

    let stakedTokens = 0;
    if (data.result.rows.length > 0) {
      stakedTokens = parseFloat(data.result.rows[0].net_staked_tokens);
    }

    console.log("stakedTokens:", stakedTokens);
    return stakedTokens >= process.env.MIN_STAKE;
  } catch (error) {
    console.error("Staking verification failed:", error.message);
    return false;
  }
}
