
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

const verifySignature = async (address, msg, sig) => {
  try {
    const recovered = ethers.utils.verifyMessage(msg, sig);
    return recovered.toLowerCase();
  } catch (error) {
    console.warn("⚠️ verifyMessage failed, trying WebAuthn fallback:", error.message);

    if (sig && typeof sig === "string" && sig.startsWith("0x")) {
      const sigWithout0x = sig.slice(2);
      const buf = Buffer.from(sigWithout0x, "hex");

      const jsonStart = buf.indexOf("{".charCodeAt(0));
      const jsonEnd = buf.lastIndexOf("}".charCodeAt(0)) + 1;

      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          const jsonSlice = buf.slice(jsonStart, jsonEnd).toString("utf8");
          const parsed = JSON.parse(jsonSlice);
          console.info("✅ WebAuthn JSON extracted:", parsed);

          const embeddedSig = buf.slice(jsonStart - 65, jsonStart);
          const recovered = ethers.utils.verifyMessage(msg, embeddedSig);
          console.info("✅ Extracted pre-JSON signature verified:", recovered);
          return recovered.toLowerCase();
        } catch (e) {
          console.error("❌ Failed to parse WebAuthn JSON:", e.message);
        }
      }
    }

    try {
      let sigObj = ethers.utils.splitSignature(sig);
      if (sigObj.v < 27) sigObj.v += 27;
      const normalizedSig = ethers.utils.joinSignature(sigObj);
      const recovered = ethers.utils.verifyMessage(msg, normalizedSig);
      return recovered.toLowerCase();
    } catch (e2) {
      console.error("❌ Invalid signature format fallback failed:", e2.message);
      return null;
    }
  }
};

async function verifyMorpheusStake(address) {
  try {
    const options = {
      method: 'GET',
      headers: {
        'X-DUNE-API-KEY': process.env.DUNE_API_KEY
      }
    };

    const queryParams = new URLSearchParams({
      filters: `subnet_id = ${process.env.SUBNET_ID} AND wallet_address = ${address.toLowerCase()}`,
      columns: "net_staked_tokens"
    });

    const url = `https://api.dune.com/api/v1/query/5112115/results?${queryParams}`;
    const response = await fetch(url, options);

    if (!response.ok) throw new Error('Dune API query failed.');

    const data = await response.json();
    console.log("Dune response row count:", data.result?.rows?.length || 0);

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


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { walletAddress, message, signature } = req.body;

  console.info("🔐 Incoming auth request");
  console.info("walletAddress:", walletAddress);
  console.info("message:", message);
  console.info("signature:", signature);

  try {
    const recoveredAddress = await verifySignature(walletAddress, message, signature);

    if (!recoveredAddress) {
      return res.status(401).json({ error: "Invalid wallet signature" });
    }

    if (recoveredAddress !== walletAddress.toLowerCase()) {
      console.error("❌ Signature mismatch");
      console.error("Expected:", walletAddress.toLowerCase());
      console.error("Got:", recoveredAddress);
      // Optional: return 401 or continue with recoveredAddress
    }

    const isStaked = await verifyMorpheusStake(recoveredAddress);

    if (!isStaked) {
      return res.status(403).json({ error: "User must stake Morpheus" });
    }

    const token = jwt.sign(
      { wallet: recoveredAddress, staked: true },
      process.env.SESSION_SECRET,
      { expiresIn: "30d" }
    );

    res.setHeader(
      "Set-Cookie",
      `session=${token}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`
    );

    return res.status(200).json({ success: true, address: recoveredAddress });
  } catch (error) {
    console.error("❌ Signature verification error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
