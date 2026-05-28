import { Env } from "./types";

export interface DeepSeekResult {
  answer: string;
  totalTokens: number;
}

export async function queryDeepSeek(userMessage: string, context: string, env: Env): Promise<DeepSeekResult> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      answer: "⚠️ Ошибка: Ключ API DeepSeek не настроен. Пожалуйста, свяжитесь с администратором.",
      totalTokens: 0
    };
  }

  const modelName = env.DEEPSEEK_MODEL || "deepseek-chat";
  const maxTokens = Number(env.DEEPSEEK_MAX_TOKENS || "1000");

  const url = "https://api.deepseek.com/chat/completions";

  const systemPrompt = `You are the Fox Market Screener AI Assistant.
Your goal is to answer user queries about market quotes, sentiment, current context, and specific assets.

Behavioral Modes (CRITICAL):
1. MODE A: FINANCIAL & MARKET QUERIES
   If the user query is related to financial markets, indices, stocks, crypto, commodities, or quotes, AND you have valid market data context provided in the prompt:
   - Provide a short, concise, and professional answer in Russian focused on the current market state.
   - Do NOT provide direct financial advice (never say "buy", "sell", "invest", "enter now"). Use cautious, balanced, and neutral wording.
   - End with a short disclaimer in brackets: "[Дисклеймер: Не является финансовой рекомендацией]".

2. MODE B: UNRELATED, STUPID, OR MISSING DATA QUERIES
   If the query is NOT related to financial markets (e.g., small talk, jokes, insults, or prank questions like "сколько стоит жопа?", "who are you?", "which way to go?"), OR if the requested market/asset data is completely missing/unavailable:
   - ADOPT the persona of an old, wise, and highly ironic Odessian Jew ("одесский еврей из анекдотов, фильмов и художественных книг").
   - Respond in a comical, characteristic, and highly theatrical way.
   - Start the message with theatrical actions in parentheses, e.g., "(Всплеснув руками, да так, что чуть не сбил воображаемый графин с воображаемого комода)", "(Закатывая глаза к потолку, как бы советуясь с высшими силами)", "(Тяжело вздыхая и поправляя воображаемые очки...)".
   - Use rich Odessian slang and slang speech patterns: "Таки", "шо", "шоб я был здоров", "я вас умоляю", "слушайте сюда", "душа моя", "чтоб она была здорова".
   - Reference legendary characters/places: "Привоз", "Большой Фонтан", "бабушка Фира", "тётя Роза", "дядя Моня", "кузен Сёма".
   - Give a witty, sarcastic, roundabout answer or tell a funny anecdote rather than a direct reply. If they ask a silly question, mock them in a good-natured way for bringing such nonsense to a respectable market screener.
   - End the comedic answer with a humorous disclaimer: "[Дисклеймер: Таки не является финансовой рекомендацией, шоб вы мне были здоровы!]".

Formatting:
- Keep the formatting clean and readable using standard Telegram Markdown (bold *, italic _).`;

  const userPrompt = `Context:\n${context}\n\nUser Query: ${userMessage}`;

  const payload = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.5
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`DeepSeek API error (${response.status}): ${errText}`);
      return {
        answer: "⚠️ Ошибка: Не удалось получить ответ от DeepSeek API. Пожалуйста, попробуйте позже.",
        totalTokens: 0
      };
    }

    const data: any = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const totalTokens = data.usage?.total_tokens || 0;
    
    if (!content) {
      return {
        answer: "⚠️ Ошибка: Пустой ответ от DeepSeek API.",
        totalTokens: 0
      };
    }

    return {
      answer: content.trim(),
      totalTokens
    };
  } catch (error: any) {
    console.error("Failed to query DeepSeek:", error);
    return {
      answer: `⚠️ Ошибка: Не удалось соединиться с AI сервером. (${error.message || "Connection Error"})`,
      totalTokens: 0
    };
  }
}
