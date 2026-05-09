const { createClient } = require('@supabase/supabase-js');

// ─── CONFIG ────────────────────────────────────────────────────────────────

const MATCH_COUNT = 5;        // Number of document chunks to retrieve per query
const MATCH_THRESHOLD = 0.45; // Minimum similarity score (0-1). Lower = more results.
const MAX_CONTEXT_CHARS = 6000; // Max characters of retrieved context to inject

// ─── HELPERS ───────────────────────────────────────────────────────────────

/**
 * Get an embedding vector for the user's message using OpenAI.
 * This converts the text into numbers the vector database can search.
 */
async function getQueryEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 2000), // Use just the latest message for search
    }),
  });
  const data = await response.json();
  if (!data.data?.[0]?.embedding) throw new Error('OpenAI embedding failed');
  return data.data[0].embedding;
}

/**
 * Search Supabase for document chunks most relevant to the query.
 * Returns formatted text ready to inject into the system prompt.
 */
async function retrieveRelevantContext(queryEmbedding) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { data, error } = await supabase.rpc('search_documents', {
    query_embedding: queryEmbedding,
    match_count: MATCH_COUNT,
    match_threshold: MATCH_THRESHOLD,
  });

  if (error) {
    console.error('Supabase search error:', error);
    return null; // Fail gracefully — continue without context
  }

  if (!data || data.length === 0) return null;

  // Format retrieved chunks as readable context
  let context = '';
  for (const chunk of data) {
    const sourceName = chunk.source.replace('.docx', '').replace(/_/g, ' ');
    const entry = `[Source: ${sourceName}]\n${chunk.content}\n\n`;
    if (context.length + entry.length > MAX_CONTEXT_CHARS) break;
    context += entry;
  }

  return context.trim();
}

/**
 * Build the enriched system prompt by injecting retrieved source material.
 * If retrieval fails, falls back to the original system prompt unchanged.
 */
function buildEnrichedSystemPrompt(originalSystem, retrievedContext) {
  if (!retrievedContext) return originalSystem;

  return `${originalSystem}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE MATERIAL FROM JAY'S BOOKS (retrieved for this specific conversation):
The following passages are extracted directly from Greg Neville's source documents and are the authoritative reference for this response. Your answer must be consistent with and grounded in this material. If this material addresses the topic at hand, use it directly — do not substitute your own summary.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${retrievedContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
END OF SOURCE MATERIAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}

// ─── MAIN HANDLER ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { messages, system, model, max_tokens } = req.body;

    // Get the user's latest message for the search query
    const latestUserMessage = messages
      ?.filter(m => m.role === 'user')
      ?.slice(-1)[0]?.content || '';

    // Step 1: Embed the user's message
    let enrichedSystem = system;
    try {
      const queryEmbedding = await getQueryEmbedding(latestUserMessage);
      
      // Step 2: Retrieve relevant document chunks
      const retrievedContext = await retrieveRelevantContext(queryEmbedding);
      
      // Step 3: Build enriched system prompt
      enrichedSystem = buildEnrichedSystemPrompt(system, retrievedContext);
      
      if (retrievedContext) {
        console.log(`RAG: Retrieved ${retrievedContext.length} chars of context`);
      } else {
        console.log('RAG: No relevant context found, using base system prompt');
      }
    } catch (ragError) {
      // RAG failure is non-fatal — continue with original system prompt
      console.error('RAG retrieval failed (non-fatal):', ragError.message);
    }

    // Step 4: Call Claude with enriched prompt
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1000,
        system: enrichedSystem,
        messages: messages,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error('Chat handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
