const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'mistral';

async function analyzeWithOllama(content, urls) {
  try {
    const prompt = `You are a Discord moderation AI. Analyze this message for scams, spam, or suspicious content.
Message: "${content}"
URLs: ${urls.length > 0 ? urls.join(', ') : 'none'}
Respond with ONLY valid JSON:
{"isSuspicious": boolean, "type": "scam|spam|phishing|impersonation|safe", "confidence": number, "reason": "brief"}`;

    const response = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt: prompt,
      stream: false,
      temperature: 0.3,
    }, { timeout: 10000 });

    const jsonMatch = response.data.response.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : response.data.response);
    
    return {
      isSuspicious: result.isSuspicious || false,
      type: result.type || 'safe',
      confidence: result.confidence || 0,
      reason: result.reason || 'Ollama analysis',
      source: 'ollama'
    };
  } catch (error) {
    console.warn('Ollama error:', error.message);
    return { isSuspicious: false, type: 'safe', confidence: 0, reason: 'Ollama unavailable', source: 'ollama' };
  }
}

async function analyzeWithClaude(content, urls, ollamaResult) {
  try {
    if (ollamaResult.confidence > 0.85 || (ollamaResult.confidence < 0.3 && urls.length === 0)) {
      return null;
    }

    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 300,
      system: 'You are a Discord scam detection expert. Respond ONLY with valid JSON:',
      messages: [{
        role: 'user',
        content: `Analyze: "${content}"\nURLs: ${urls.join(', ') || 'none'}\nOllama: ${ollamaResult.type} (${Math.round(ollamaResult.confidence * 100)}%)\nRespond: {"isScam": boolean, "confidence": number, "scamType": "string", "reasoning": "string"}`,
      }],
    });

    const responseText = response.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    const result = JSON.parse(jsonMatch ? jsonMatch[0] : responseText);

    return {
      isScam: result.isScam || false,
      confidence: result.confidence || 0,
      scamType: result.scamType || 'safe',
      reasoning: result.reasoning || 'Claude analysis',
      source: 'claude'
    };
  } catch (error) {
    console.error('Claude error:', error.message);
    return null;
  }
}

module.exports = { analyzeWithOllama, analyzeWithClaude };
