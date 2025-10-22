import { Pinecone } from "@pinecone-database/pinecone";
//import { HfInference } from "@huggingface/inference";
import { HfInference } from "@huggingface/inference";
import axios from "axios";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  
  // Add this right after your CORS headers
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  // Handle preflight requests
  if (method === "OPTIONS") {
    return res.status(200).end();
  }

	const verifySignature = async (address, msg, sig) => {
	  try {
		// 1. Try standard signature
		const recovered = ethers.utils.verifyMessage(msg, sig);
		return recovered.toLowerCase() === address.toLowerCase();
	  } catch (error) {
		try {
		  // 2. Check if sig is JSON-encoded (Coinbase Android sometimes returns JSON)
		  if (typeof sig === 'string') {
			try {
			  const parsed = JSON.parse(sig);
			  const possibleSigs = [
				parsed.signature,
				parsed.response?.signature
			  ].filter(Boolean);

			  for (const s of possibleSigs) {
				const recovered = ethers.utils.verifyMessage(msg, s);
				if (recovered.toLowerCase() === address.toLowerCase()) return true;
			  }
			} catch (e) {
			  // Not a JSON string — move on
			}

			// 3. Check for JSON embedded inside hex string
			if (sig.startsWith('0x')) {
			  const sigWithout0x = sig.slice(2);
			  const jsonStart = sigWithout0x.indexOf('{');
			  const jsonEnd = sigWithout0x.lastIndexOf('}') + 1;

			  if (jsonStart !== -1 && jsonEnd > jsonStart) {
				try {
				  const jsonString = sigWithout0x.slice(jsonStart, jsonEnd);
				  const webAuthnResponse = JSON.parse(jsonString);
				  const nestedSigs = [
					webAuthnResponse.signature,
					webAuthnResponse.response?.signature
				  ].filter(Boolean);

				  for (const s of nestedSigs) {
					const recovered = ethers.utils.verifyMessage(msg, s);
					if (recovered.toLowerCase() === address.toLowerCase()) return true;
				  }
				} catch (e) {
				  console.log("Failed to parse embedded JSON");
				}
			  }

			  // 4. Normalize v values and try again
			  let sigObj = ethers.utils.splitSignature(sig);
			  if (sigObj.v < 27) sigObj.v += 27;
			  const normalizedSig = ethers.utils.joinSignature(sigObj);
			  const recovered = ethers.utils.verifyMessage(msg, normalizedSig);
			  return recovered.toLowerCase() === address.toLowerCase();
			}
		  }

		  // 5. As last resort, try raw address recovery (for weirdly signed messages)
		  const recovered = ethers.utils.recoverAddress(
			ethers.utils.hashMessage(msg),
			sig
		  );
		  return recovered.toLowerCase() === address.toLowerCase();
		} catch (e) {
		  return false;
		}
	  }
	};

	
  try {
    const {
      text,
      history,
	  timeframe,
	  type,
	  api,
	  model,
      walletAddress,
      signature,
      message,
      token
    } = req.body;

    if (!text) return res.status(400).json({ error: "Missing 'text' in request body" });
	
	let verifiedAddress = null;

	console.log("Timeframe", timeframe);
	
	console.log("Model", model);
	
	console.log("API", api);
	
	console.log("Type", type);
	
	console.log("Message", message);

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
	
	// ✅ PLACE THE COINBASE SESSION CLEANUP CODE RIGHT HERE
    // CRITICAL FIX #2: COINBASE SESSION CLEANUP
    if (verifiedAddress && !token) {
      // Coinbase often connects without proper session token
      // Force token generation for subsequent requests
      const newToken = jwt.sign({ address: verifiedAddress }, process.env.SESSION_SECRET, {
        expiresIn: "30d"
      });
      
      res.setHeader("X-Coinbase-Token", newToken);
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
		} else if (type == "image"){
			return res.status(403).json({ error: "Image generation is only allowed for users who have staked 10 MOR." });
		}
	}
	
	if (!cookieStaked && type == "image"){
		return res.status(403).json({ error: "Image generation is only allowed for users who have staked 10 MOR." });
	}
	

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
	
	let startDateMilliseconds = new Date(2019, 1, 1, 0, 0, 0, 0).getTime();
	const nowInMilliseconds = Date.now();
	
	if(timeframe == "day"){
		const millisecondsIn24Hours = 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsIn24Hours;
	} else if(timeframe == "week"){
		const millisecondsInWeek = 7 * 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsInWeek;
	} else if(timeframe == "month"){
		const millisecondsInMonth = 31 * 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsInMonth;
	} else if(timeframe == "year"){
		const millisecondsInYear = 366 * 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsInYear;
	} else if(timeframe == "two-year"){
		const millisecondsInYear = 2 * 366 * 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsInYear;
	} else if(timeframe == "four-year"){
		const millisecondsInYear = 4* 366 * 24 * 60 * 60 * 1000;
		startDateMilliseconds = nowInMilliseconds - millisecondsInYear;
	}
	
	const startDate = Math.floor(startDateMilliseconds / 1000);
	console.log("Start Date", startDate);

	let endDateMilliseconds = today.getTime();
	const endDate = Math.floor(endDateMilliseconds / 1000);
	console.log("End Date", endDate);	
	
	//text += "\n\nContext: The current date and time is " + today + ".";
	
	let context = '';

	if (type != "image"){
		
		context = "Here is the Context that you need to exhaustively incorporate in your response:\n\n";
		
		const queryEmbedding = await getEmbedding(text);
		const pineconeIndex = await initPinecone();
	
		const results = await pineconeIndex.query({
		  vector: queryEmbedding,
		  topK: process.env.MAX_CONTEXT_PARAGRAPHS,
		  includeMetadata: true,
		  filter: {
			timestamp: { $gte: startDate, $lte: endDate },
		  },
		});
	  
		context += results.matches
		  .map(match => 
			'Title: ' + match.metadata?.title + "\n" +
			'Author: ' + match.metadata?.author + "\n" +
			'Content: ' + match.metadata?.content + "\n" + 
			'Date: ' + match.metadata?.date + "\n" +
			'Primary URL: https://dissentwatch.com/boost/?boost_post_id=' + match.metadata?.post_id +
			(match.metadata?.nostr_event_id ? "\nNOSTR URL: https://primal.net/e/" + match.metadata?.nostr_event_id : '')
			|| '')
		  .join("\n\n");
		  
		context += "If the user asks you to generate an image please advise them to select 'Images' instead of 'Text' in the 'Type' dropdown of this app.";
	} else {
		context = "Generate an image following the user's instructions meticulously.";
	}
	
    const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + " Today's date and time is " + today + ". Use this date as a reference point for any predictions, analyses, or interpretations of events when formulating your response." },
      //{ role: 'system', content: 'What follows is a set of paragraphs representing online posts that are relevant to this conversation, also known as Context. They are ordered by relevance from more to less relevant. Each Context paragraph consists of Title, Author, Content, Date, Primary URL, and optionally NOSTR URL. When formulating your answer you must incorporate the Content and use the standard markdown formatting outlined before to reference Title, Author, Primary URL (and the NOSTR URL if and only if provided) from every single paragraph from the following Context: \n\n' + context },
	  { role: 'system', content: context },
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
	
	let apiUrl = process.env.VENICE_API_CHAT_COMPLETION;
	let apiKey = process.env.VENICE_API_KEY;
	
	if (api == "Morpheus"){
		apiUrl = process.env.MORPHEUS_API_CHAT_COMPLETION;
		apiKey = process.env.MORPHEUS_API_KEY;
	}
	
	if (type == "image"){
		apiUrl = process.env.VENICE_API_GENERATE_IMAGE;
	}
	
	let messageObject = {
		model: model,
		messages: messages,
		max_tokens: maxTokens
	};
		  
	if (type == 'image') {
		messageObject = {
			"model": model,
			"prompt": text,
			"safe_mode": false
		  }
	}

	while (retries <= maxRetries) {
	  try {
		const apiResponse = await axios.post(
		  apiUrl,
		  messageObject,
		  {
			headers: {
			  "Authorization": `Bearer ${apiKey}`,
			  "Content-Type": "application/json"
			},
			responseType: "json"
		  }
		);
		
		
		console.log("FULL API RESPONSE OBJECT:", apiResponse.data);
		
		if (type == 'image') {
			console.log("answer:", apiResponse.data.images[0]);
			// ✅ SUCCESS — BREAK RETRY LOOP
			res.status(200).json({
			  answer: apiResponse.data.images[0],
			  context,
			  web_search_citations: []
			});
			
		} else {
			console.log("answer:", apiResponse.data.choices[0].message.content);
			// ✅ SUCCESS — BREAK RETRY LOOP
			res.status(200).json({
			  answer: apiResponse.data.choices[0].message.content,
			  context,
			  web_search_citations: apiResponse.data?.venice_parameters?.web_search_citations
			});
		}
		
		break;

	  } catch (error) {
		apiError = error;
		retries++;

		// ✅ LOG RETRY
		console.error(`API (${apiUrl}) failed (attempt ${retries}/${maxRetries + 1})`, error.message);

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
