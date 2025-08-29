import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
import axios from "axios";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  try {
    const {
      text,
      history,
      walletAddress,
      signature,
      message,
      token
    } = req.body;

    if (!text) return res.status(400).json({ error: "Missing 'text' in request body" });
	
	let verifiedAddress = null;

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.SESSION_SECRET);
        verifiedAddress = decoded.address.toLowerCase();
      } catch (e) {
        return res.status(401).json({ error: "Invalid session token" });
      }
    } else if (walletAddress && signature && message) {
      const isValidSignature = await verifySignature(walletAddress, message, signature);
      if (!isValidSignature) {
        return res.status(401).json({ error: "Invalid wallet signature" });
      }
      verifiedAddress = walletAddress.toLowerCase();
    }

    // ✅ INSERT STEP 2 CODE HERE — VERIFY SIGNED COOKIE
    const cookieHeader = req.headers.cookie;
    let cookieStaked = false;

    if (cookieHeader) {
      const cookies = cookieHeader.split("; ").reduce((acc, cookie) => {
        const [key, value] = cookie.split("=");
        acc[key.trim()] = value.trim();
        return acc;
      }, {});

      const signedCookie = cookies.isStaked;

      if (signedCookie) {
        try {
          const decoded = jwt.verify(signedCookie, process.env.SESSION_SECRET);
          if (decoded.staked && decoded.wallet) {
            // ✅ Double-check stake status in case cookie is old
            const currentStakeStatus = await verifyMorpheusStake(decoded.wallet);
            if (currentStakeStatus) {
              cookieStaked = true;
            } else {
              // ✅ Clear forged/expired cookie
              res.setHeader(
                "Set-Cookie",
                "isStaked=; Max-Age=0; Path=/; Secure; SameSite=None; Domain=.dissentbot.com"
              );
			  return res.status(403).json({ error: "Invalid cookie" });
            }
          }
        } catch (e) {
          // ❌ Invalid JWT — clear forged cookie
          res.setHeader(
            "Set-Cookie",
            "isStaked=; Max-Age=0; Path=/; Secure; SameSite=None; Domain=.dissentbot.com"
          );
		  return res.status(403).json({ error: "Invalid cookie" });
        }
      }
    }
	
	
	if (!cookieStaked) {

		// ✅ NOW CHECK STAKE AFTER verifiedAddress IS DEFINED
		const isStaked = verifiedAddress ? await verifyMorpheusStake(verifiedAddress) : false;
		
		// ✅ SET JWT-SIGNED COOKIE
		if (isStaked) {
		  const cookieValue = jwt.sign(
			{ wallet: verifiedAddress, staked: true },
			process.env.SESSION_SECRET,
			{ expiresIn: "30d" }
		  );

		  res.setHeader(
			"Set-Cookie",
			`isStaked=${cookieValue}; Max-Age=2592000; Path=/; Secure; SameSite=None; Domain=.dissentbot.com`
		  );
		}
	}
	
/*
    if (verifiedAddress && !isStaked) {
      return res.status(403).json({
        error: "Need 10+ MOR tokens staked"
      });
    }
*/
    const verifySignature = (address, msg, sig) => {
      try {
        const recovered = ethers.utils.verifyMessage(msg, sig);
        return recovered.toLowerCase() === address.toLowerCase();
      } catch (error) {
        return false;
      }
    };

    const getEmbedding = async (text) => {
      try {
        const hf = new HfInference(process.env.HF_API_TOKEN);
        return await hf.featureExtraction({
          model: "sentence-transformers/all-MiniLM-L6-v2",
          inputs: text
        });
      } catch (error) {
        throw new Error("Embedding failed: " + (error.message || "Unknown"));
      }
    };

    const initPinecone = async () => {
      try {
        const pinecone = new Pinecone({ 
          apiKey: process.env.PINECONE_API_KEY
        });
        return pinecone.Index(process.env.PINECONE_INDEX_NAME);
      } catch (error) {
        throw new Error("Pinecone init failed: " + (error.message || "Unknown"));
      }
    };

	const today = new Date();
	
	let startDate = new Date(2019, 1, 1, 0, 0, 0, 0).getTime();
	console.log("Start Date", startDate);

	let endDate = today.getTime();
	console.log("End Date", endDate);	
	
	//text += "\n\nContext: The current date and time is " + today + ".";

    const queryEmbedding = await getEmbedding(text);
    const pineconeIndex = await initPinecone();
    const results = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: process.env.MAX_CONTEXT_PARAGRAPHS,
      includeMetadata: true,
/*	  filter: {
		timestamp: { $gte: startDate, $lte: endDate },
	  },*/
    });
  
    const context = results.matches
      .map(match => 
		'Title: ' + match.metadata?.title + "\n" +
		'Author: ' + match.metadata?.author + "\n" +
		'Content: ' + match.metadata?.content + "\n" + 
		'Date & Time: ' + match.metadata?.date + "\n" +
		'Primary URL: https://dissentwatch.com/boost/?boost_post_id=' + match.metadata?.post_id +
		(match.metadata?.nostr_event_id ? "\nNOSTR URL: https://primal.net/e/" + match.metadata?.nostr_event_id : '')
		|| '')
      .join("\n\n");
	
    const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + " Today's date and time is " + today + "." },
      //{ role: 'system', content: 'What follows is a set of paragraphs representing online posts that are relevant to this conversation, also known as Context. They are ordered by relevance from more to less relevant. Each Context paragraph consists of Title, Author, Content, Date, Primary URL, and optionally NOSTR URL. When formulating your answer you must incorporate the Content and use the standard markdown formatting outlined before to reference Title, Author, Primary URL (and the NOSTR URL if and only if provided) from every single paragraph from the following Context: \n\n' + context },
	  { role: 'system', content: 'Context\n\n' + context },
      ...history.map(msg => ({ role: msg.role, content: msg.content /*.replace(/<[^>]*>?/gm, '')*/ })),
    ];
	
	
	// Convert max_tokens to number
	const maxTokens = parseInt(process.env.MAX_TOKENS) || 500;

    console.log("API Request Payload:", JSON.stringify(messages, null, 2));
	console.log("MAX_TOKENS: ", maxTokens);

	// ✅ RETRY 5 TIMES ON 500 ERROR
	let retries = 0;
	const maxRetries = 5;
	let apiError = null;

	while (retries <= maxRetries) {
	  try {
		const apiResponse = await axios.post(
		  process.env.API_URL_CHAT_COMPLETION,
		  {
			model: process.env.MODEL_ID,
			messages: messages,
			max_tokens: maxTokens
		  },
		  {
			headers: {
			  "Authorization": `Bearer ${process.env.API_KEY}`,
			  "Content-Type": "application/json"
			},
			responseType: "json"
		  }
		);

		// ✅ SUCCESS — BREAK RETRY LOOP
		res.status(200).json({
		  answer: apiResponse.data.choices[0].message.content,
		  context
		});
		break;

	  } catch (error) {
		apiError = error;
		retries++;

		// ✅ LOG RETRY
		console.error(`API (${process.env.API_URL_CHAT_COMPLETION}) failed (attempt ${retries}/${maxRetries + 1})`, error.message);

		// ✅ ONLY RETRY ON 500-LEVEL ERRORS
		if (
		  error.response &&
		  (error.response.status >= 500 && error.response.status <= 599)
		) {
		  if (retries <= maxRetries) {
			// ✅ WAIT 1s BETWEEN RETRIES
			await new Promise((resolve) => setTimeout(resolve, 1000));
			continue;
		  }
		}

		// ✅ ALL RETRIES FAILED — RETURN ERROR TO CLIENT
		res.status(500).json({ error: "AI network temporarily unavailable" });
		return;
	  }
	}

/*
	const apiResponse = await axios.post(
	  process.env.API_URL_CHAT_COMPLETION,
	  {
		model: process.env.MODEL_ID,
		messages: messages,
		max_tokens: maxTokens 
	  },
	  {
		headers: {
		  'Authorization': `Bearer ${process.env.API_KEY}`,
		  'Content-Type': 'application/json'
		},
        responseType: 'json'
	  }
	);
	
	console.log("Answer:", apiResponse.data.choices[0].message.content);
	
    res.status(200).json({
      answer: apiResponse.data.choices[0].message.content,
      context
    });
	
*/

  } catch (error) {
    console.error("Server error:", error.message);
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
