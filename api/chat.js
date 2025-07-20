// pages/api/chat.js
import { Pinecone } from "@pinecone-database/pinecone";
import { HfInference } from "@huggingface/inference";
import axios from "axios";
import { ethers } from "ethers";
import jwt from "jsonwebtoken";

export default async function handler(req, res) {
  // ✅ Minimal Vercel compatibility (no Express req/res)
  const { method } = req;
  if (method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // 🔁 Core chat logic (no rate limit stores in Vercel)
    const {
      text,
      history,
      walletAddress,
      signature,
      message,
      token
    } = req.body;

    if (!text) return res.status(400).json({ error: "Missing 'text' in request body" });

    // ✅ Vercel version of verifySignature
    const verifySignature = (address, message, signature) => {
      try {
        const recoveredAddress = ethers.utils.verifyMessage(message, signature);
        return recoveredAddress.toLowerCase() === address.toLowerCase();
      } catch (error) {
        console.error("Signature verification failed:", error.message);
        return false;
      }
    };

    // ✅ Vercel version of getEmbedding
    const getEmbedding = async (text) => {
      try {
        const hfEmbeddings = new HfInference(process.env.HF_API_TOKEN);
        const response = await hfEmbeddings.featureExtraction({
          model: "sentence-transformers/all-MiniLM-L6-v2",
          inputs: text
        });
        return response;
      } catch (error) {
        console.error("Embedding generation failed:", error);
        throw new Error("Failed to generate embedding");
      }
    };

    // ✅ Vercel version of initPinecone
    const initPinecone = async () => {
      try {
        return new Pinecone({
          apiKey: process.env.PINECONE_API_KEY,
        }).Index(process.env.PINECONE_INDEX_NAME);
      } catch (error) {
        console.error("Pinecone initialization failed:", error);
        throw new Error("Failed to initialize Pinecone");
      }
    };

    // ✅ Process chat request
    const queryEmbedding = await getEmbedding(text);
    const pineconeIndex = await initPinecone();
    const results = await pineconeIndex.query({
      vector: queryEmbedding,
      topK: 15,
      includeMetadata: true
    });

    const context = results.matches.map(match => match.metadata?.content + '...').join("\n\n");
    const today = new Date();
    const messages = [
      { role: 'system', content: process.env.INSTRUCTIONS + " Today's date: " + today },
      { role: 'system', content: 'Context: \n\n' + context },
      ...history.map(msg => ({ role: msg.role, content: msg.content })),
    ];

    const apiResponse = await axios.post(
      process.env.API_URL_CHAT_COMPLETION,
      { model: process.env.MODEL_ID, messages, max_tokens: process.env.MAX_TOKENS },
      { headers: { 'Authorization': `Bearer ${process.env.API_KEY}` } }
    );

    res.status(200).json({
      answer: apiResponse.data.choices[0].message.content,
      context
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}