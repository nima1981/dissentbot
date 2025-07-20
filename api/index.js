const express = require('express');
const { Pinecone } = require('@pinecone-database/pinecone');
const { HfInference } = require('@huggingface/inference');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 1000;
const MAX_CONTEXT_PARAGRAPHS = parseInt(process.env.MAX_CONTEXT_PARAGRAPHS) || 15;

const SUBNET_ID = process.env.SUBNET_ID || '0x29d6c72e0af35f863f8c8345529ad5ad19b70b0d46225228e27c082710db4bfb';
const { ethers } = require("ethers");

// Add to top of index.js
const jwt = require('jsonwebtoken');
const SESSION_SECRET = process.env.SESSION_SECRET || 'fallback-secret-key-1234567890';

// Add to top of index.js
const rateLimitStore = {};
const RATE_LIMIT = process.env.RATE_LIMIT || 3; // Max requests
const RATE_WINDOW = process.env.RATE_WINDOW || 30 * 60 * 1000; // 30 minutes

// At the top of index.js, after rateLimitStore
const ipRateLimitStore = {};
const ANONYMOUS_RATE_LIMIT = process.env.ANONYMOUS_RATE_LIMIT || 3;
const ANONYMOUS_WINDOW = process.env.ANONYMOUS_WINDOW || 30 * 60 * 1000; // 30 minutes

const MIN_STAKE = process.env.MIN_STAKE || 10;
const DUNE_API_KEY = process.env.DUNE_API_KEY;
//const MOCK_STAKE = 10;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Validate environment
const validateEnv = () => {
  const required = [
    "PINECONE_API_KEY",
    "PINECONE_ENVIRONMENT",
    "PINECONE_INDEX_NAME",
    "API_KEY",
    "API_URL_CHAT_COMPLETION",
    "MODEL_ID",
    "HF_API_TOKEN",
    "SUBNET_ID",
	"DUNE_API_KEY"
  ];
  
  required.forEach((key) => {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  });
};

// Pinecone initialization with error logging
let pineconeClient;
let pineconeIndex;
const initPinecone = async () => {
  try {
    const environment = process.env.PINECONE_ENVIRONMENT;

    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });

    const pineconeIndex = pineconeClient.Index(process.env.PINECONE_INDEX_NAME);
    console.log("Pinecone initialized successfully");
    return pineconeIndex;
  } catch (error) {
    console.error("Pinecone initialization failed:", error);
    throw new Error("Failed to initialize Pinecone");
  }
};

// Hugging Face embedding function with error logging
async function getEmbedding(text) {
  try {
    const hfEmbeddings = new HfInference(process.env.HF_API_TOKEN);
    const response = await hfEmbeddings.featureExtraction({
      model: "sentence-transformers/all-MiniLM-L6-v2",
      inputs: text,
    });

    // Directly take the array as the embedding
    const vector = response;

    if (!Array.isArray(vector) || vector.length !== 384) {
      throw new Error(`Invalid vector dimensions: Expected 384, got ${vector.length}`);
    }

    return vector;
  } catch (error) {
    console.error("Embedding generation failed:", error);
    throw new Error("Failed to generate embedding");
  }
}

// Add this helper function
async function listModels() {
  try {
    const response = await axios.get(
      process.env.API_URL_MODELS,
      {
        headers: {
          'Authorization': `Bearer ${process.env.API_KEY}`,
        },
      }
    );
    console.log("Available models:", response.data);
    return response.data;
  } catch (error) {
    console.error("Failed to fetch models:", error);
    throw error;
  }
}

// Verify wallet signature using ethers.js
async function verifySignature(address, message, signature) {
  try {
    // Ethereum prefix is already included in personal_sign
    const recoveredAddress = ethers.utils.verifyMessage(message, signature);
    return recoveredAddress.toLowerCase() === address.toLowerCase();
  } catch (error) {
    console.error("Signature verification failed:", error.message);
    return false;
  }
}

// Verify Morpheus stake

	async function verifyMorpheusStake(address) {
	  try {
				
		const options = {method: 'GET', headers: {'X-DUNE-API-KEY': DUNE_API_KEY}};
		
		const queryParams = new URLSearchParams({
			filters: "subnet_id = " + SUBNET_ID + " AND wallet_address = " + address,
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
		return stakedTokens >= MIN_STAKE;
		
  } catch (error) {
    console.error("Staking verification failed:", error);
    return false;
  }
}

// Chat endpoint
app.post('/api', async (req, res) => {
  
  // At the top of /api route
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'anonymous';
	
  try {
	  
    const { text, history, walletAddress, signature, message, token } = req.body;
	
	if (!text) {
      return res.status(400).json({ error: "Missing 'text' in request body" });
    }
	
	console.log("Received user query:", text);
		
	const clientIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'anonymous';
	//const ipKey = `ip_${clientIp}`;
	const key = `ip_${clientIp}`;
	
	// ✅ Apply anonymous rate limit first
    if (!walletAddress && !token) {
      const now = Date.now();
      
      if (!ipRateLimitStore[key]) {
        ipRateLimitStore[key] = { count: 1, timestamp: now };
      } else {
        if (now - ipRateLimitStore[key].timestamp > ANONYMOUS_WINDOW) {
          ipRateLimitStore[key] = { count: 1, timestamp: now };
        } else {
          ipRateLimitStore[key].count += 1;
          if (ipRateLimitStore[key].count > ANONYMOUS_RATE_LIMIT) {
            return res.status(429).json({
              error: "ANONYMOUS_RATE_LIMIT_EXCEEDED"
            });
          }
        }
      }
    }
	
	let verifiedAddress = null;
	
	//const isStaked = await verifyMorpheusStake(walletAddress);

/*	 if (!isStaked) {
	   return res.status(403).json({ error: "Need 10 MOR tokens staked to use this service" });
	  }
*/
	
    if (token) {
      try {
        const decoded = jwt.verify(token, SESSION_SECRET);
        verifiedAddress = decoded.address;
      } catch (e) {
        return res.status(401).json({ error: "Invalid session token" });
      }
    } else if (walletAddress && signature && message) {
      const isValidSignature = await verifySignature(walletAddress, message, signature);
      if (!isValidSignature) {
		console.log("Signature invalid for", walletAddress);
        return res.status(401).json({ error: "Invalid wallet signature" });
      }
      verifiedAddress = walletAddress;
    } else if (!walletAddress && !token) {
      // ✅ Allow anonymous users to proceed if under limit
      // ✅ Stake check will be skipped later
    } else {
      return res.status(401).json({ error: "Wallet authentication required" });
    }

	
	// Now that we have verifiedAddress, check staking
    const isStaked = verifiedAddress ? await verifyMorpheusStake(verifiedAddress) : false;
	
	    // Rate limit logic

    if (verifiedAddress && !isStaked) {
      const now = Date.now();
      const key = verifiedAddress;

      if (!rateLimitStore[key]) {
        rateLimitStore[key] = { count: 1, timestamp: now };
      } else {
        if (now - rateLimitStore[key].timestamp > RATE_WINDOW) {
          rateLimitStore[key] = { count: 1, timestamp: now };
        } else {
          rateLimitStore[key].count += 1;
          if (rateLimitStore[key].count > RATE_LIMIT) {
            return res.status(429).json({
              error: "RATE_LIMIT_EXCEEDED"
            });
          }
        }
      }
    }

    // Process chat request
    const queryEmbedding = await getEmbedding(text);
	const pineconeIndex = await initPinecone();
    const results = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: MAX_CONTEXT_PARAGRAPHS,
      includeMetadata: true
    });

    const context = results.matches
      .map(match => match.metadata?.content + 
		' (Title: ' + match.metadata?.title + '; ' +
		'Date & Time: ' + match.metadata?.date + '; ' + 
	    'Sources: ' + 
		'Primary URL ' + match.metadata?.dissentwatch_url + ', ' +
	    'Archive URL ' + match.metadata?.archive_url + ', ' +
		'Original URL ' + match.metadata?.source_url + ', ' +
		'Author ' + match.metadata?.author + 
		(match.metadata?.nostr_event_id ? ', NOSTR Discussion URL https://primal.net/e/' + match.metadata?.nostr_event_id : '') +
		' )'
		|| '')
      .join("\n\n");
	  
	console.log('pinecone results: ' . results);

    const today = new Date();
	
    const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + " Today's date and time is " + today + "." },
      { role: 'system', content: 'Context: \n\n' + context },
      ...history.map(msg => ({ role: msg.role, content: msg.content /*.replace(/<[^>]*>?/gm, '')*/ })),
    ];
	
    console.log("API Request Payload:", JSON.stringify(messages, null, 2));
	console.log("MAX_TOKENS: ", MAX_TOKENS);
	
    const apiResponse = await axios.post(
      process.env.API_URL_CHAT_COMPLETION,
      {
        model: process.env.MODEL_ID,
        messages: messages,
        max_tokens: MAX_TOKENS,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.API_KEY}`,
          'Content-Type': 'application/json'
        },
        responseType: 'json'
      }
    );

    const apiAnswer = apiResponse.data.choices?.[0]?.message?.content || "No response from API";
    console.log("Answer Length:", apiAnswer.length); // Log the answer length
    console.log("Answer:", apiAnswer); // Log the answer on the server side
	console.log("Cleaned up answer:", apiAnswer.replaceAll("[/REF]","").replaceAll("[REF]","")); // Log the answer on the server side
    //res.json({ answer: apiAnswer.replaceAll("[/REF]","").replaceAll("[REF]",""), context });
	res.json({ answer: apiAnswer, context });
    
  } catch (error) {
    if (error.response) {
      console.error("API ERROR RESPONSE:", error.response.data);
      res.status(error.response.status).json({ error: error.response.data });
    } else {
      console.error("ERROR IN CHAT ENDPOINT:", error.message);
      res.status(400).json({ error: error.message });
    }
  }
});

// Add this endpoint
app.post('/auth', async (req, res) => {
  const { walletAddress, signature, message } = req.body;

  if (!walletAddress || !signature || !message) {
    return res.status(401).json({ error: "Authentication required" });
  }

  /*
  const isStaked = await verifyMorpheusStake(walletAddress);
  if (!isStaked) {
    return res.status(403).json({ error: "Need 10+ MOR tokens staked" });
  }
  */

  const isValidSignature = await verifySignature(walletAddress, message, signature);
  if (!isValidSignature) {
    return res.status(401).json({ error: "Invalid wallet signature" });
  }

  // Issue session token
  const token = jwt.sign({ address: walletAddress }, SESSION_SECRET, { expiresIn: '30d' });
  
  res.json({ 
    token, 
    address: walletAddress,
    message: "Authentication successful"
  });
});

// Server startup
app.listen(PORT, async () => {
  try {
    validateEnv();
    await initPinecone();
	await listModels();
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
});