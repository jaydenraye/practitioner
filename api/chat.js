const { createClient } = require('@supabase/supabase-js');
 
const MATCH_COUNT = 8;          // Retrieve more chunks for detailed organ queries
const MATCH_THRESHOLD = 0.25;   // Lower threshold — practitioner queries may use different language
const MAX_CONTEXT_CHARS = 10000; // Larger context for detailed mind/body data
 
async function getQueryEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text.slice(0, 2000),
    }),
  });
  const data = await response.json();
  if (!data.data?.[0]?.embedding) throw new Error('OpenAI embedding failed');
  return data.data[0].embedding;
}
 
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
    return null;
  }
 
  if (!data || data.length === 0) return null;
 
  let context = '';
  for (const chunk of data) {
    const sourceName = chunk.source.replace('.docx', '').replace(/_/g, ' ');
    const entry = `[Source: ${sourceName} | Similarity: ${chunk.similarity.toFixed(2)}]\n${chunk.content}\n\n`;
    if (context.length + entry.length > MAX_CONTEXT_CHARS) break;
    context += entry;
  }
 
  return context.trim();
}
 
function buildEnrichedSystemPrompt(originalSystem, retrievedContext) {
  if (!retrievedContext) return originalSystem;
 
  return `${originalSystem}
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE MATERIAL RETRIEVED FROM JAY'S DOCUMENTS:
The following passages have been retrieved directly from Greg Neville's source documents. This is the authoritative reference for this response. Use this material directly — do not substitute your own summary or generate content that is not here.
 
IMPORTANT: If the retrieved material contains specific organ abilities, use them exactly as written. Do not modify, interpret, or expand on them beyond what is stated.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 
${retrievedContext}
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
END OF SOURCE MATERIAL
If the information needed is not in the retrieved material above, say clearly: "I don't have sufficient data on this specific area — refer to the corresponding source document."
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
}
 
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
 
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
 
  try {
    const { messages, system, model, max_tokens } = req.body;
 
    const latestUserMessage = messages
      ?.filter(m => m.role === 'user')
      ?.slice(-1)[0]?.content || '';
 
    let enrichedSystem = system;
    try {
      const queryEmbedding = await getQueryEmbedding(latestUserMessage);
      const retrievedContext = await retrieveRelevantContext(queryEmbedding);
      enrichedSystem = buildEnrichedSystemPrompt(system, retrievedContext);
 
      if (retrievedContext) {
        console.log(`RAG: Retrieved ${retrievedContext.length} chars of context`);
      } else {
        console.log('RAG: No relevant context found above threshold');
      }
    } catch (ragError) {
      console.error('RAG retrieval failed (non-fatal):', ragError.message);
    }
 
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 1200,
        system: enrichedSystem,
        messages: messages,
      }),
    });
 
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    return res.status(200).json(data);
 
  } catch (error) {
    console.error('Chat handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
 
