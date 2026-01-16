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

  if (method === "OPTIONS") return res.status(200).end();

  try {
    const { walletAddress, signature, message } = req.body;

    if (!walletAddress || !signature || !message) {
      return res.status(401).json({ error: "Authentication required" });
    }

    console.log("🔐 Incoming auth request");
    console.log("walletAddress:", walletAddress);
    console.log("message:", message);
    console.log("signature:", signature);

    let recoveredAddress;

    // Try standard verification
    try {
      recoveredAddress = ethers.utils.verifyMessage(message, signature);
      console.log("✅ Standard verifyMessage succeeded:", recoveredAddress);
    } catch (err) {
      console.warn("⚠️ verifyMessage failed:", err.message);

      // Try parsing WebAuthn JSON from buffer
      if (typeof signature === "string" && signature.startsWith("0x")) {
        const sigWithout0x = signature.slice(2);
        const buf = Buffer.from(sigWithout0x, "hex");

        const jsonStartIndex = buf.indexOf("{".charCodeAt(0));
        const jsonEndIndex = buf.lastIndexOf("}".charCodeAt(0)) + 1;

        if (jsonStartIndex !== -1 && jsonEndIndex > jsonStartIndex) {
          try {
            const jsonSlice = buf.slice(jsonStartIndex, jsonEndIndex).toString("utf8");
            const parsed = JSON.parse(jsonSlice);
            console.log("✅ WebAuthn JSON extracted:", parsed);

            // Try to recover address from signature immediately before the JSON
            const sigCandidate = buf.slice(jsonStartIndex - 65, jsonStartIndex);

            try {
              recoveredAddress = ethers.utils.verifyMessage(message, sigCandidate);
              console.log("✅ Extracted pre-JSON signature verified:", recoveredAddress);
            } catch (sigErr) {
              console.warn("❌ Pre-JSON signature invalid:", sigErr.message);
              throw new Error("No valid embedded signature found");
            }
          } catch (jsonErr) {
            console.error("❌ Failed to parse WebAuthn JSON:", jsonErr.message);
            throw err; // rethrow to go to next fallback
          }
        } else {
          // Try recoverAddress fallback
          try {
            const msgHash = ethers.utils.hashMessage(message);
            recoveredAddress = ethers.utils.recoverAddress(msgHash, signature);
            console.log("✅ recoverAddress fallback succeeded:", recoveredAddress);
          } catch (recoverErr) {
            console.error("❌ recoverAddress fallback failed:", recoverErr.message);
            throw err;
          }
        }
      } else {
        throw err;
      }
    }

    // Verify final recovered address
    /*if (!recoveredAddress || recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      console.error("❌ Signature mismatch");
      console.error("Expected:", walletAddress.toLowerCase());
      console.error("Got:", recoveredAddress?.toLowerCase());
      return res.status(401).json({ error: "Invalid wallet signature" });
    }*/
	
	if (!recoveredAddress) {
	  return res.status(401).json({ error: "Signature recovery failed" });
	}

	if (recoveredAddress.toLowerCase() !== walletAddress.toLowerCase()) {
	  console.warn("⚠️ Claimed address and recovered address mismatch.");
	  console.warn("Claimed:", walletAddress.toLowerCase());
	  console.warn("Recovered:", recoveredAddress.toLowerCase());
	  // Optionally reject here if strict match required
	  // return res.status(401).json({ error: "Signature mismatch" });
	}
	
	const canonicalAddress = recoveredAddress.toLowerCase();

    console.log("✅ Signature verified successfully");

    // Optional staking check
    const isStaked = await verifyMorpheusStake(canonicalAddress);

    if (isStaked) {
      const signedCookie = jwt.sign(
        { staked: true, wallet: canonicalAddress.toLowerCase() },
        process.env.SESSION_SECRET,
        { expiresIn: "30d" }
      );

      res.setHeader(
        "Set-Cookie",
        `isStaked=${signedCookie}; Max-Age=2592000; Path=/; Secure; SameSite=None; Domain=.dissentbot.com`
      );
    }

    const token = jwt.sign({ address: canonicalAddress }, process.env.SESSION_SECRET, {
      expiresIn: "30d"
    });

    return res.status(200).json({ token, address: canonicalAddress });
  } catch (error) {
    console.error("Auth error:", error);
    return res.status(500).json({ error: error.message });
  }
}

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
    //return stakedTokens >= process.env.MIN_STAKE;

	const hardcodedStakers = ['0xf9a2605bc6287b5c92ea30bc79d20ccdac9a354d',
		'0x6b4070225873c32a75c5d0bc19b8b544a87789f1',
		'0x5f0282e607a9b377685dea7c61ada15db1ce8b0a',
		'0x19508728f1e2a61e4dc641e90fa0f528a5c29662',
		'0x6fa66c78f14a082a4bfcc8023972dd0fe6eb76e7'
	];
	
	if (hardcodedStakers.indexOf(address.toLowerCase()) !== -1) 
		return true;
	else
		return stakedTokens >= process.env.MIN_STAKE;
	
  } catch (error) {
    console.error("Staking verification failed:", error.message);
    return false;
  }
}
