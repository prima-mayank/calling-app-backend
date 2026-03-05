const MAX_INPUT_CHARS = 250_000;
const MAX_SUMMARY_CHARS = 600;
const MAX_BULLETS = 5;
const SENTENCE_SPLIT_REGEX = /(?<=[.!?])\s+/;

const normalizeText = (value) => {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
};

const toSentences = (text) =>
  String(text || "")
    .split(SENTENCE_SPLIT_REGEX)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

const createSummaryFromSentences = (sentences, fallbackText) => {
  if (!Array.isArray(sentences) || sentences.length === 0) {
    return String(fallbackText || "").slice(0, MAX_SUMMARY_CHARS).trim();
  }

  const sentenceCount = Math.min(4, Math.max(2, sentences.length));
  let summary = sentences.slice(0, sentenceCount).join(" ").trim();
  if (!summary) {
    summary = String(fallbackText || "").slice(0, MAX_SUMMARY_CHARS).trim();
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS - 3).trimEnd()}...`;
  }
  return summary;
};

const createBullets = (sentences) =>
  (Array.isArray(sentences) ? sentences : [])
    .slice(0, MAX_BULLETS)
    .map((sentence) =>
      sentence.length > 180 ? `${sentence.slice(0, 177).trimEnd()}...` : sentence
    );

const summarizeWithMockProvider = ({ text, truncated }) => {
  const sentences = toSentences(text);
  const summary = createSummaryFromSentences(sentences, text);
  const bullets = createBullets(sentences);
  return {
    summary: summary || String(text || "").slice(0, MAX_SUMMARY_CHARS).trim(),
    bullets,
    truncated: !!truncated,
  };
};

const summarizeWithOpenAiExample = async ({ text, truncated }) => {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    return summarizeWithMockProvider({ text, truncated });
  }

  // Example only:
  // const response = await fetch("https://api.openai.com/v1/responses", {
  //   method: "POST",
  //   headers: {
  //     "Content-Type": "application/json",
  //     Authorization: `Bearer ${apiKey}`,
  //   },
  //   body: JSON.stringify({
  //     model: "gpt-4.1-mini",
  //     input: `Summarize this meeting transcript and provide bullets:\n\n${text}`,
  //   }),
  // });
  // const data = await response.json();
  // Parse provider payload into { summary, bullets }.
  // return { summary, bullets, truncated };

  return summarizeWithMockProvider({ text, truncated });
};

export const summarizeText = async (inputText) => {
  if (typeof inputText !== "string") {
    const error = new Error("invalid_input");
    error.code = "invalid_input";
    throw error;
  }

  const normalizedInput = normalizeText(inputText);
  if (!normalizedInput) {
    const error = new Error("invalid_input");
    error.code = "invalid_input";
    throw error;
  }

  const truncated = normalizedInput.length > MAX_INPUT_CHARS;
  const text = truncated ? normalizedInput.slice(0, MAX_INPUT_CHARS) : normalizedInput;
  const provider = String(process.env.SUMMARIZER_PROVIDER || "mock")
    .trim()
    .toLowerCase();

  if (provider === "openai") {
    return summarizeWithOpenAiExample({ text, truncated });
  }

  return summarizeWithMockProvider({ text, truncated });
};

export const __TEST_ONLY__ = {
  MAX_INPUT_CHARS,
};
