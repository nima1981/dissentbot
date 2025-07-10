const express = require('express');
const { Pinecone } = require('@pinecone-database/pinecone'); // Pinecone v6.0.1
const { HfInference } = require('@huggingface/inference'); // Hugging Face inference
const path = require('path');
const axios = require('axios'); // For API requests

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS) || 1000;


app.use(express.json()); // Parse JSON bodies
app.use(express.static('public'));

// Validate environment variables
const validateEnv = () => {
  const required = [
    "PINECONE_API_KEY",
    "PINECONE_ENVIRONMENT",
    "PINECONE_INDEX_NAME",
    "API_KEY",
    "API_URL_CHAT_COMPLETION",
    "MODEL_ID",
    "HF_API_TOKEN",
  ];
  required.forEach((key) => {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  });
};

// Pinecone initialization with error logging
let pineconeClient;
const initPinecone = async () => {
  try {
    const environment = process.env.PINECONE_ENVIRONMENT;
    const controllerHostUrl = `https://controller.${environment}.pinecone.io`;

    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
      //controllerHostUrl,
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

// Chat endpoint with API integration and exhaustive error handling
app.post('/api', async (req, res) => {
  try {
    const userQuery = req.body?.text;
    const conversationHistory = req.body?.history || [];
    console.log("Received user query:", userQuery);

    if (!userQuery) {
      return res.status(400).json({ error: "Missing 'text' in request body" });
    }

    const queryEmbedding = await getEmbedding(userQuery);
    const pineconeIndex = await initPinecone();
    const results = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: 15,
      includeMetadata: true,
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

    // Construct the messages array for API
	const today = new Date();
    
	const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + "Today's date and time is " + today + "."},
	  { role: 'system', content: 'Context: \n\n' + context }, // Add context here
      ...conversationHistory.map(msg => ({ role: msg.role, content: msg.content.replace(/<[^>]*>?/gm, '') })),
    ];
    /* the code below duplicates the user prompt so I've removed it
	const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + "Today's date and time is " + today + "."},
      ...conversationHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userQuery },
      { role: 'system', content: context }, // Add context here
    ];*/

    // Log the request payload being sent to the API
    console.log("API Request Payload:", JSON.stringify(messages, null, 2));
	console.log("MAX_TOKENS: ", MAX_TOKENS);
    // API call with corrected endpoint
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
          'Content-Type': 'application/json',
        },
        responseType: 'json'
      }
    );

    const apiAnswer = apiResponse.data.choices?.[0]?.message?.content || "No response from API";
    console.log("Answer Length:", apiAnswer.length); // Log the answer length
    console.log("Answer:", apiAnswer); // Log the answer on the server side
	console.log("Cleaned up answer:", apiAnswer.replaceAll("[/REF]","").replaceAll("[REF]","")); // Log the answer on the server side
    res.json({ answer: apiAnswer.replaceAll("[/REF]","").replaceAll("[REF]",""), context });
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