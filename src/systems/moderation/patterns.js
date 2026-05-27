const SCAM_PATTERNS = [
  { name: 'Shortened URLs', pattern: /https?:\/\/(bit\.ly|tinyurl\.com|short\.link|goo\.gl)/i, confidence: 0.6, type: 'phishing' },
  { name: 'Fake Discord', pattern: /(discord\.gg|discordgg|disc\.gg)[^\s]*/i, confidence: 0.7, type: 'phishing' },
  { name: 'Wallet Verify', pattern: /verify.*(wallet|account)|connect.*(wallet|account)/i, confidence: 0.85, type: 'crypto_scam' },
  { name: 'Free NFT', pattern: /free.*nft|airdrop.*now|claim.*reward/i, confidence: 0.8, type: 'crypto_scam' },
  { name: 'Pump Dump', pattern: /pump.*dump|guaranteed.*profit|get.*rich.*quick|moon.*soon/i, confidence: 0.75, type: 'crypto_scam' },
  { name: 'Seed Phrase', pattern: /send.*seed|share.*password|private.*key/i, confidence: 0.9, type: 'phishing' },
];

function checkLocalPatterns(content) {
  for (const pattern of SCAM_PATTERNS) {
    if (pattern.pattern.test(content)) {
      return {
        flagged: true,
        type: pattern.type,
        confidence: pattern.confidence,
        pattern: pattern.name,
      };
    }
  }
  return { flagged: false };
}

module.exports = { checkLocalPatterns, SCAM_PATTERNS };
