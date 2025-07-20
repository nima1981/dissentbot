// ✅ chat.js
import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
import axios from "axios";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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
        // ❌ OLD: const pinecone = new Pinecone({ apiKey, environment });
        // ✅ NEW: environment is now handled automatically
        const pinecone = new Pinecone({ 
          apiKey: process.env.PINECONE_API_KEY
        });
        return pinecone.Index(process.env.PINECONE_INDEX_NAME);
      } catch (error) {
        throw new Error("Pinecone init failed: " + (error.message || "Unknown"));
      }
    };

    const queryEmbedding = await getEmbedding(text);
    const pineconeIndex = await initPinecone();
    const results = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: 15,
      includeMetadata: true
    });

    const context = results.matches
      .map(match => match.metadata?.content + '...').join("\n\n");

    const today = new Date();
    const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + " Today: " + today },
      { role: 'system', content: 'Context: \n\n' + context },
      ...history.map(msg => ({ role: msg.role, content: msg.content }))
    ];
	
	// ✅ Convert max_tokens to number
	const maxTokens = parseInt(process.env.MAX_TOKENS) || 500;

	const apiResponse = await axios.post(
	  process.env.API_URL_CHAT_COMPLETION,
	  {
		model: process.env.MODEL_ID,
		messages: messages,
		max_tokens: maxTokens // ✅ NOW IT'S A NUMBER
	  },
	  {
		headers: {
		  'Authorization': `Bearer ${process.env.API_KEY}`,
		  'Content-Type': 'application/json'
		}
	  }
	);

    res.status(200).json({
      answer: apiResponse.data.choices[0].message.content,
      context
    });

  } catch (error) {
    console.error("Server error:", error.message);
    res.status(500).json({ error: error.message });
  }
}