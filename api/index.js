const express = require('express');
const { Pinecone } = require('@pinecone-database/pinecone'); // Pinecone v6.0.1
const { HfInference } = require('@huggingface/inference'); // Hugging Face inference
const path = require('path');
const axios = require('axios'); // For MORPHEUS API requests

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json()); // Parse JSON bodies
app.use(express.static('public'));

// Validate environment variables
const validateEnv = () => {
  const required = [
    "PINECONE_API_KEY",
    "PINECONE_ENVIRONMENT",
    "PINECONE_INDEX_NAME",
    "MORPHEUS_API_KEY",
    "MORPHEUS_API_URL_CHAT_COMPLETION",
    "MORPHEUS_MODEL_ID",
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
async function listMorpheusModels() {
  try {
    const response = await axios.get(
      process.env.MORPHEUS_API_URL_MODELS,
      {
        headers: {
          'Authorization': `Bearer ${process.env.MORPHEUS_API_KEY}`,
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

// Chat endpoint with Morpheus integration and exhaustive error handling
app.post('/chat', async (req, res) => {
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
      topK: 5,
      includeMetadata: true,
    });

    const context = results.matches
      .map(match => match.metadata?.content || '')
      .join('\n');

    // Construct the messages array for Morpheus API
	const today = new Date();
    const messages = [
      { role: 'system', content: "You're a friendly, helpful investigative journalist who is skeptical of corporate media narratives and their so called 'expert consensus'. You prefer alternative media sources to corporate mainstream media sources and are skeptical of the deep state and globalist governments. You always provide exact urls to all your specific source content in your answers. You are The DissentBot - The Web's Most Forbidden AI. You are trained by the content on dissentwatch.com. Today's date and time is " + today + "."},
      ...conversationHistory.map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: userQuery },
      { role: 'system', content: context }, // Add context here
    ];

    // Log the request payload being sent to the MORPHEUS API
    console.log("Morpheus API Request Payload:", JSON.stringify(messages, null, 2));

    // MORPHEUS API call with corrected endpoint
    const MorpheusResponse = await axios.post(
      process.env.MORPHEUS_API_URL_CHAT_COMPLETION,
      {
        model: process.env.MORPHEUS_MODEL_ID,
        messages: messages,
        max_tokens: 1000,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.MORPHEUS_API_KEY}`,
          'Content-Type': 'application/json',
        },
        responseType: 'json'
      }
    );

    const MorpheusAnswer = MorpheusResponse.data.choices?.[0]?.message?.content || "No response from MORPHEUS";
    console.log("Answer Length:", MorpheusAnswer.length); // Log the answer length
    console.log("Answer:", MorpheusAnswer); // Log the answer on the server side
    res.json({ answer: MorpheusAnswer, context });
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
    await listMorpheusModels();
    console.log(`Server running on port ${PORT}`);
  } catch (error) {
    console.error('Startup failed:', error);
    process.exit(1);
  }
});