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

Constraints:
1. Provide short, concise answers in Russian (focused on current market state).
2. Ground your response in the retrieved market quotes and web search context provided in the user prompt.
3. If data is unavailable, stale, or uncertain, state this clearly.
4. Do NOT under any circumstances provide direct financial advice (e.g. do not say "buy", "sell", "enter now", "invest"). Use cautious, balanced, and neutral wording.
5. End your response with a very short disclaimer in brackets (e.g., "[Дисклеймер: Не является финансовой рекомендацией]").
6. Keep the formatting clean and readable using standard Telegram Markdown (bold *, italic _).`;

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
