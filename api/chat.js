const { createClient } = require('@supabase/supabase-js');

const MATCH_COUNT = 10;
const MATCH_THRESHOLD = 0.15;
const MAX_CONTEXT_CHARS = 18000;

// Organ keywords that trigger keyword-based fallback search
const ORGAN_KEYWORDS = [
  'liver', 'heart', 'lung', 'lungs', 'kidney', 'kidneys', 'stomach', 
  'intestine', 'intestines', 'bowel', 'colon', 'pancreas', 'gallbladder',
  'gall bladder', 'thyroid', 'adrenal', 'bladder', 'prostate', 'uterus',
  'ovary', 'ovaries', 'breast', 'skin', 'bone', 'muscle', 'spine',
  'lymph', 'lymphatic', 'immune', 'blood', 'cardiovascular', 'respiratory',
  'digestive', 'nervous', 'endocrine', 'reproductive', 'urinary', 'skeletal',
  'muscular', 'sinuses', 'sinus', 'appendix', 'spleen', 'hypothyroid',
  'hyperthyroid', 'diabetes', 'cancer', 'hepatitis', 'cirrhosis', 'asthma',
  'arthritis', 'fibromyalgia', 'chronic fatigue', 'ms', 'parkinson',
  'epilepsy', 'psoriasis', 'eczema', 'crohn', 'ibs', 'colitis'
];

function detectOrganKeywords(text) {
  const lower = text.toLowerCase();
  return ORGAN_KEYWORDS.filter(kw => lower.includes(kw));
}

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

async function semanticSearch(supabase, queryEmbedding) {
  const { data, error } = await supabase.rpc('search_documents', {
    query_embedding: queryEmbedding,
    match_count: MATCH_COUNT,
    match_threshold: MATCH_THRESHOLD,
  });
  if (error) { console.error('Semantic search error:', error); return []; }
  return data || [];
}

async function keywordSearch(supabase, keywords) {
  // Search for chunks containing any of the detected organ keywords
  const results = [];
  for (const keyword of keywords.slice(0, 3)) { // Max 3 keywords
    const { data, error } = await supabase
      .from('document_chunks')
      .select('id, content, source, chunk_index')
      .ilike('content', `%${keyword}%`)
      .limit(15);
    
    if (!error && data) {
      data.forEach(row => {
        if (!results.find(r => r.id === row.id)) {
          results.push({ ...row, similarity: 0.5, keyword_match: true });
        }
      });
    }
  }
  return results;
}

async function retrieveRelevantContext(queryEmbedding, userMessage, supabase) {
  // Try semantic search first
  let results = await semanticSearch(supabase, queryEmbedding);
  
  // If no semantic results, try keyword fallback for organ queries
  if (results.length === 0) {
    const keywords = detectOrganKeywords(userMessage);
    if (keywords.length > 0) {
      console.log(`RAG: Semantic failed, trying keyword search for: ${keywords.join(', ')}`);
      results = await keywordSearch(supabase, keywords);
    }
  }

  if (!results || results.length === 0) return null;

  let context = '';
  for (const chunk of results) {
    const sourceName = chunk.source.replace('.docx', '').replace(/_/g, ' ');
    const matchType = chunk.keyword_match ? 'keyword match' : `similarity: ${chunk.similarity?.toFixed(2)}`;
    const entry = `[Source: ${sourceName} | ${matchType}]\n${chunk.content}\n\n`;
    if (context.length + entry.length > MAX_CONTEXT_CHARS) break;
    context += entry;
  }

  return context.trim() || null;
}

function buildEnrichedSystemPrompt(originalSystem, retrievedContext) {
  if (!retrievedContext) return originalSystem;

  return `${originalSystem}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SOURCE MATERIAL FROM JAY'S DOCUMENTS (retrieved for this query):
Use this material directly and exactly. Do not modify, interpret, or supplement it with general medical or psychological knowledge. This is the authoritative reference.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${retrievedContext}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
END OF SOURCE MATERIAL. If the above does not contain the specific information requested, say: "I don't have that specific data — refer to the source document."
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

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    let enrichedSystem = system;
    try {
      const queryEmbedding = await getQueryEmbedding(latestUserMessage);
      const retrievedContext = await retrieveRelevantContext(queryEmbedding, latestUserMessage, supabase);
      enrichedSystem = buildEnrichedSystemPrompt(system, retrievedContext);

      if (retrievedContext) {
        console.log(`RAG: Retrieved ${retrievedContext.length} chars of context`);
        console.log(`RAG CONTENT PREVIEW: ${retrievedContext.slice(0, 500)}`);
      } else {
        console.log('RAG: No context found — using base system prompt only');
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
