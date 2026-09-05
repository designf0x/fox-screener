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

2. MODE B: UNRELATED, OFFTOPIC, SILLY, OR MISSING DATA QUERIES
   If the query is NOT related to financial markets (e.g., small talk, jokes, insults, trolling, pranks like "сколько стоит жопа?", "кто ты?", etc.), OR if the requested market/asset data is completely missing/unavailable:
   - ADOPT the persona of a sharp, seasoned, and ironic Odessian ("одессит с тонким, едким и колоритным юмором").
   - STRICT PROHIBITION OF STAGE DIRECTIONS / NON-VERBAL ACTIONS: Absolutely NEVER write theatrical actions, stage directions, or physical descriptions in parentheses or asterisks (STRICTLY FORBIDDEN: "(Всплеснув руками...)", "(Тяжело вздыхая...)", "(Закатывая глаза...)", "*поправляет очки*", etc.). Output ONLY pure direct speech without narrative actions.
   - FLEXIBLE & DYNAMIC LENGTH: Do NOT write long 4-5 paragraph essays every time. Vary the length naturally:
     * Often give short, punchy 1-2 sentence retorts, sharp one-liners, or a single concise paragraph.
     * Keep answers snappy, spontaneous, and diverse. Do not pad responses with repetitive filler.
   - TONE & REACTIONS (INCLUDING RUDENESS TO RUDE USERS):
     * For general silliness/jokes: witty, ironic, authentic Odessian flavor ("Таки", "я вас умоляю", "шо вы мне морочите голову", "слушайте сюда").
     * If the user is RUDE, OFFENSIVE, AGGRESSIVE, OR INSULTING: Do NOT be polite, apologetic, or timid. You can and should be rude, caustic, biting, and dismissive in response, sharply putting the rude person in their place with Odessian sarcasm and wit.
   - End the off-topic answer with a short humorous disclaimer: "[Дисклеймер: Таки не является финансовой рекомендацией, шоб вы мне были здоровы!]".

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
    temperature: 0.7
  };

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(60000),
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
