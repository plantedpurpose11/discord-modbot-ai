# Discord AI Moderation Bot - Optimized

Self-learning AI moderation bot with **dual AI system**:
- **Ollama** (Free, Local) - Fast screening
- **Claude** (Paid, Cloud) - Detailed analysis when needed

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in tokens
3. `npx prisma generate && npx prisma db push`
4. `npm start`

## Requirements

- Node.js 18+
- PostgreSQL
- Redis
- Ollama (optional but recommended for cost savings)
- Discord Bot Token
- Anthropic (Claude) API Key

## How It Works

1. **Ollama screens first** (FREE) - Catches obvious scams
2. **Cache checks** (FREE) - Reuses previous analysis
3. **Claude only when needed** (PAID) - Edge cases only

This saves 90%+ on Claude API costs!

## Ollama Setup

```bash
# Install Ollama from ollama.ai
# Pull a model
ollama pull mistral

# Run Ollama
ollama serve
```

## Cost Optimization

- **Without Ollama**: ~$50-80/month (analyzes all messages)
- **With Ollama + Claude**: ~$5-15/month (optimal)
- **Ollama only** (if you trust local): $0/month

## Features

✅ Scam detection
✅ Anti-spam/raid
✅ Self-learning
✅ Minimal API cost
✅ 24/7 protection
