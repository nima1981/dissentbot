// pages/api/auth.js
import jwt from "jsonwebtoken";
import { ethers } from "ethers";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");

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

	if (isStaked) {
	  const signedCookie = jwt.sign(
		{ staked: true },
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
    res.status(500).json({ error: error.message });
  }
}

// Verify Morpheus stake

async function verifyMorpheusStake(address) {
	try {
				
		const options = {method: 'GET', headers: {'X-DUNE-API-KEY': process.env.DUNE_API_KEY}};
		
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
		console.log("Dune data response: JSON.stringify(data.result.rows.length)): " + JSON.stringify(data.result.rows.length));
		//const response = {"data": {"stakedAmount": MOCK_STAKE}};
		
		let stakedTokens = 0;
		
		if (data.result.rows.length > 0)
			stakedTokens = parseFloat(data.result.rows[0].net_staked_tokens);
		
		console.log("stakedTokens: " + stakedTokens);
		
		//return MOCK_STAKE >= MIN_STAKE;		
		return stakedTokens >= process.env.MIN_STAKE;
		
	} catch (error) {
		console.error("Staking verification failed:", error);
		return false;
	}
}
